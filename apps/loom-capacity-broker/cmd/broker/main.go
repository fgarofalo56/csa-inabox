// Command broker is the Loom Capacity Broker (HYP-9): a stateful admission-
// control service exposing a synchronous POST /admit choke-point over a
// 2,880 x 30-second timepoint ledger. Azure-native only — Redis (Azure Cache for
// Redis) when LOOM_BROKER_REDIS is set, in-process ledger otherwise so the core
// path EXECUTES end-to-end with no external dependency (no-vaporware.md). It
// never contacts api.fabric.microsoft.com / api.powerbi.com — no Fabric
// dependency (no-fabric-dependency.md).
//
// Endpoints (internal ingress only — reached by the Console BFF on the CAE):
//
//	GET  /healthz                      liveness/readiness (+ ledger backend)
//	POST /admit                        the hot path — admit|delay|reject
//	POST /report                       record actual post-run consumption
//	GET  /ledger/{tenant}/{workspace}  timepoint state for the admin UI
//	GET  /policy?tenant=&workspace=    read per-workspace policy
//	PUT  /policy?tenant=&workspace=    upsert per-workspace policy (FGC-25)
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"loom-capacity-broker/internal/broker"
	"loom-capacity-broker/internal/ledger"
)

func main() {
	ctx := context.Background()

	led, err := ledger.New(ctx)
	if err != nil {
		// Honest: redis was configured but unreachable — we fell back to memory.
		log.Printf("[broker] ledger backend fell back to memory: %v", err)
	}
	log.Printf("[broker] ledger backend: %s", led.Backend())

	store := newPolicyStore()
	b := broker.New(led).WithPolicy(store.get)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		hctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := led.Ping(hctx); err != nil {
			writeErr(w, http.StatusServiceUnavailable, "ledger backend unreachable")
			return
		}
		writeOK(w, http.StatusOK, map[string]any{"status": "healthy", "backend": led.Backend()})
	})

	mux.HandleFunc("POST /admit", func(w http.ResponseWriter, r *http.Request) {
		var req broker.AdmitRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if req.TenantID == "" {
			writeErr(w, http.StatusBadRequest, "tenantId required")
			return
		}
		if req.RequestedLcu < 0 {
			writeErr(w, http.StatusBadRequest, "requestedUnits must be >= 0")
			return
		}
		res, err := b.Admit(r.Context(), req)
		if err != nil {
			log.Printf("[broker] admit error: %v", err)
			writeErr(w, http.StatusInternalServerError, "admission evaluation failed")
			return
		}
		writeOK(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /report", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			TenantID    string  `json:"tenantId"`
			WorkspaceID string  `json:"workspaceId"`
			ActualLcu   float64 `json:"actualLcu"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if body.TenantID == "" {
			writeErr(w, http.StatusBadRequest, "tenantId required")
			return
		}
		if err := b.Report(r.Context(), body.TenantID, body.WorkspaceID, body.ActualLcu); err != nil {
			log.Printf("[broker] report error: %v", err)
			writeErr(w, http.StatusInternalServerError, "report failed")
			return
		}
		writeOK(w, http.StatusOK, map[string]any{"recorded": true, "backend": led.Backend()})
	})

	mux.HandleFunc("GET /ledger/{tenant}/{workspace}", func(w http.ResponseWriter, r *http.Request) {
		tenant := r.PathValue("tenant")
		workspace := r.PathValue("workspace")
		horizon := 120
		if h := r.URL.Query().Get("horizon"); h != "" {
			if v, err := strconv.Atoi(h); err == nil {
				horizon = v
			}
		}
		st, err := b.State(r.Context(), tenant, workspace, horizon)
		if err != nil {
			log.Printf("[broker] ledger read error: %v", err)
			writeErr(w, http.StatusInternalServerError, "ledger read failed")
			return
		}
		writeOK(w, http.StatusOK, st)
	})

	mux.HandleFunc("GET /policy", func(w http.ResponseWriter, r *http.Request) {
		tenant := r.URL.Query().Get("tenant")
		workspace := r.URL.Query().Get("workspace")
		writeOK(w, http.StatusOK, map[string]any{"policy": store.get(r.Context(), tenant, workspace)})
	})

	mux.HandleFunc("PUT /policy", func(w http.ResponseWriter, r *http.Request) {
		tenant := r.URL.Query().Get("tenant")
		workspace := r.URL.Query().Get("workspace")
		if tenant == "" {
			writeErr(w, http.StatusBadRequest, "tenant query param required")
			return
		}
		var pol broker.Policy
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&pol); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		store.set(tenant, workspace, pol)
		writeOK(w, http.StatusOK, map[string]any{"policy": pol})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("[broker] listening on :%s", port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("[broker] server error: %v", err)
	}
}

// policyStore is the per-tenant/workspace policy layer (FGC-25 surge protection
// promoted to the broker). In-memory for the skeleton; HYP-12 persists it via
// the Console's Cosmos-backed guardrails route.
type policyStore struct {
	mu sync.RWMutex
	m  map[string]broker.Policy
}

func newPolicyStore() *policyStore { return &policyStore{m: make(map[string]broker.Policy)} }

func (p *policyStore) key(tenant, workspace string) string { return tenant + "\x00" + workspace }

func (p *policyStore) get(_ context.Context, tenant, workspace string) broker.Policy {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if pol, ok := p.m[p.key(tenant, workspace)]; ok {
		return pol
	}
	return broker.DefaultPolicy()
}

func (p *policyStore) set(tenant, workspace string, pol broker.Policy) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.m[p.key(tenant, workspace)] = pol
}

// --- structured {ok,...} envelope (mirrors the Console BFF respond.ts) ---

func writeOK(w http.ResponseWriter, status int, payload any) {
	// Merge payload fields alongside ok:true so responses are flat
	// ({ok:true, decision, reason, ...}) — matching the Console BFF envelope.
	out := map[string]any{"ok": true}
	if m, isMap := payload.(map[string]any); isMap {
		for k, v := range m {
			out[k] = v
		}
	} else if b, err := json.Marshal(payload); err == nil {
		var fields map[string]any
		if json.Unmarshal(b, &fields) == nil {
			for k, v := range fields {
				out[k] = v
			}
		} else {
			out["data"] = payload
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(out)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": msg})
}
