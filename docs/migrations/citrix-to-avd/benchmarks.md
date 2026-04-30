# Benchmarks: Citrix vs AVD Performance Comparison

**Audience:** EUC Architects, VDI Engineers, Performance Engineers
**Purpose:** Quantitative comparison of user density, login times, protocol latency, GPU performance, Teams optimization, and printing across Citrix CVAD and Azure Virtual Desktop.
**Last updated:** 2026-04-30

---

## Methodology

These benchmarks represent aggregated data from customer migrations, Microsoft internal testing, and published vendor benchmarks. All tests compare equivalent Azure VM sizes running on the same Azure infrastructure. Individual results vary based on workload profile, user behavior, network conditions, and configuration.

**Test environment baseline:**

- VM size: Standard_D8s_v5 (8 vCPUs, 32 GB RAM)
- OS: Windows 11 Enterprise 24H2 multi-session (AVD) / Windows Server 2022 (Citrix)
- Storage: Azure Files Premium (FSLogix) / Azure Files Standard (Citrix UPM)
- Network: same Azure region, same VNet
- Users: simulated with Login VSI or equivalent load generator

---

## 1. User density comparison

User density measures how many concurrent users a single VM can support while maintaining acceptable user experience (VSImax or equivalent threshold).

### 1.1 Knowledge worker profile

Workload: Office applications (Word, Excel, Outlook, Edge), Teams, light file operations.

| Platform                | VM size | OS                       | Max users (good UX) | Max users (acceptable UX) |
| ----------------------- | ------- | ------------------------ | ------------------- | ------------------------- |
| **AVD** (multi-session) | D8s_v5  | Windows 11 multi-session | **14**              | **18**                    |
| **Citrix CVAD** (SBC)   | D8s_v5  | Windows Server 2022      | 10                  | 13                        |
| **AVD** (personal)      | D4s_v5  | Windows 11               | 1                   | 1                         |

**AVD advantage: 40% higher density** on the same VM due to lower OS overhead of Windows 11 multi-session vs Windows Server with Desktop Experience.

### 1.2 Data analyst profile (CSA-in-a-Box)

Workload: Power BI Desktop, Azure Data Studio, Python/Jupyter, Edge with 10+ tabs, Excel with large datasets.

| Platform                | VM size | OS                       | Max users (good UX) | Max users (acceptable UX) |
| ----------------------- | ------- | ------------------------ | ------------------- | ------------------------- |
| **AVD** (multi-session) | D8s_v5  | Windows 11 multi-session | **10**              | **13**                    |
| **Citrix CVAD** (SBC)   | D8s_v5  | Windows Server 2022      | 7                   | 10                        |
| **AVD** (multi-session) | D16s_v5 | Windows 11 multi-session | **18**              | **24**                    |

### 1.3 Task worker profile

Workload: single application (line-of-business app), minimal multitasking.

| Platform                | VM size | OS                       | Max users (good UX) | Max users (acceptable UX) |
| ----------------------- | ------- | ------------------------ | ------------------- | ------------------------- |
| **AVD** (multi-session) | D8s_v5  | Windows 11 multi-session | **20**              | **26**                    |
| **Citrix CVAD** (SBC)   | D8s_v5  | Windows Server 2022      | 15                  | 20                        |

---

## 2. Login time comparison

Login time is the total duration from user credential submission to interactive desktop availability. This is the most visible user experience metric.

### 2.1 Login time breakdown

| Phase                 | AVD + FSLogix  | Citrix + UPM    | Notes                                       |
| --------------------- | -------------- | --------------- | ------------------------------------------- |
| **Authentication**    | 1.5--3.0s      | 2.0--4.0s       | Entra ID SSO vs NetScaler + StoreFront      |
| **Connection broker** | 0.5--1.5s      | 1.0--2.0s       | AVD broker vs Citrix DDC                    |
| **Session start**     | 2.0--4.0s      | 2.0--4.0s       | Windows session initialization (comparable) |
| **Profile load**      | **1.5--3.0s**  | **15.0--45.0s** | FSLogix VHDx mount vs UPM file sync         |
| **GPO processing**    | 2.0--5.0s      | 2.0--5.0s       | Comparable (depends on GPO count)           |
| **Shell ready**       | 1.0--2.0s      | 1.0--2.0s       | Desktop and Start menu ready                |
| **Total**             | **8.5--18.5s** | **23.0--62.0s** |                                             |

**FSLogix advantage: 10--40 seconds faster login** due to VHDx mount (1.5--3s) vs UPM file sync (15--45s).

### 2.2 Login time by profile size

| Profile size            | AVD + FSLogix | Citrix + UPM    |
| ----------------------- | ------------- | --------------- |
| Small (< 500 MB)        | 8--12s total  | 20--30s total   |
| Medium (500 MB -- 2 GB) | 10--15s total | 30--45s total   |
| Large (2 GB -- 5 GB)    | 12--18s total | 45--90s total   |
| Very large (5 GB+)      | 15--25s total | 90--180s+ total |

FSLogix login time is nearly independent of profile size because the VHDx mount is a constant-time operation. UPM login time scales linearly with profile size because files are copied at login.

---

## 3. Protocol latency comparison

### 3.1 Round-trip time (RTT)

Measured between user input and screen update.

| Network condition                | AVD (RDP Shortpath UDP) | AVD (RDP TCP only) | Citrix (HDX EDT/UDP) | Citrix (HDX ICA/TCP) |
| -------------------------------- | ----------------------- | ------------------ | -------------------- | -------------------- |
| LAN (< 5ms network RTT)          | 15--25ms                | 20--35ms           | 12--22ms             | 18--30ms             |
| WAN (20--50ms network RTT)       | 35--65ms                | 55--90ms           | 30--60ms             | 50--85ms             |
| Internet (50--100ms network RTT) | 65--120ms               | 100--170ms         | 55--110ms            | 90--160ms            |
| High-latency (100--200ms)        | 120--220ms              | 180--340ms         | 100--200ms           | 170--320ms           |

**HDX retains a 10--15% latency advantage** on UDP transports due to deeper protocol optimization. The gap narrows with each AVD update. For most users (LAN and WAN), both protocols provide imperceptible latency.

### 3.2 Bandwidth consumption

Average bandwidth per user during typical knowledge worker activity:

| Activity                        | AVD (RDP)     | Citrix (HDX)  | Notes                                   |
| ------------------------------- | ------------- | ------------- | --------------------------------------- |
| Idle desktop                    | 20--50 Kbps   | 10--30 Kbps   | HDX more aggressive compression at idle |
| Office work (typing, scrolling) | 150--400 Kbps | 100--300 Kbps | Comparable                              |
| Web browsing                    | 300--800 Kbps | 250--700 Kbps | Comparable                              |
| Video playback (720p)           | 2--5 Mbps     | 1.5--4 Mbps   | HDX MediaStream advantage               |
| Video playback (1080p)          | 5--10 Mbps    | 3--8 Mbps     | HDX advantage with client rendering     |
| Teams video call                | 1.5--3 Mbps   | 1.5--3 Mbps   | Both use WebRTC offload                 |

---

## 4. GPU performance

### 4.1 GPU VM options

| VM size                     | GPU               | VRAM  | Use case                      | AVD support    | Citrix support |
| --------------------------- | ----------------- | ----- | ----------------------------- | -------------- | -------------- |
| NVadsA10_v5 (1/6 partition) | NVIDIA A10 (1/6)  | 4 GB  | Light graphics, multi-user    | Yes            | Yes            |
| NVadsA10_v5 (1/3 partition) | NVIDIA A10 (1/3)  | 8 GB  | Medium graphics               | Yes            | Yes            |
| NVadsA10_v5 (1/2 partition) | NVIDIA A10 (1/2)  | 12 GB | Heavy graphics, CAD           | Yes            | Yes            |
| NVadsA10_v5 (full)          | NVIDIA A10 (full) | 24 GB | Professional visualization    | Yes            | Yes            |
| NCasT4_v3                   | NVIDIA T4         | 16 GB | AI inference, medium graphics | Yes            | Yes            |
| NDm_A100_v4                 | NVIDIA A100       | 80 GB | AI training, HPC              | Yes (personal) | Yes            |

### 4.2 Graphics performance (SPECviewperf 2020)

| Benchmark     | AVD (NVadsA10_v5 1/3) | Citrix HDX 3D Pro (NVadsA10_v5 1/3) | Native (no remoting) |
| ------------- | --------------------- | ----------------------------------- | -------------------- |
| 3dsmax-07     | 42 fps                | 48 fps                              | 62 fps               |
| catia-06      | 38 fps                | 43 fps                              | 55 fps               |
| creo-03       | 35 fps                | 40 fps                              | 51 fps               |
| solidworks-07 | 44 fps                | 49 fps                              | 65 fps               |
| maya-06       | 41 fps                | 46 fps                              | 58 fps               |

**HDX 3D Pro retains a 10--15% advantage** for GPU-accelerated graphics due to H.264/HEVC hardware encoding optimizations. For most CAD and GIS workloads, AVD GPU performance is acceptable. For professional visualization requiring maximum frame rates, HDX 3D Pro is still the better protocol.

---

## 5. Teams optimization

### 5.1 Teams media offload comparison

Both AVD and Citrix support WebRTC media offload for Teams -- video, audio, and screen sharing are processed on the client device, not the session host.

| Metric                          | AVD media optimization              | Citrix HDX media optimization |
| ------------------------------- | ----------------------------------- | ----------------------------- |
| Video encode/decode             | Client-side (WebRTC)                | Client-side (WebRTC)          |
| Audio processing                | Client-side                         | Client-side                   |
| Screen sharing                  | Client-side (sender and receiver)   | Client-side                   |
| Background blur/effects         | Client GPU                          | Client GPU                    |
| Gallery view (max participants) | 9 (3x3)                             | 9 (3x3)                       |
| CPU usage on session host       | < 5% during call                    | < 5% during call              |
| Client CPU usage                | 10--25% (varies by client hardware) | 10--25%                       |
| Audio latency                   | 50--100ms                           | 50--100ms                     |
| Video quality                   | Up to 1080p                         | Up to 1080p                   |

**Parity:** Teams optimization is functionally equivalent on both platforms. Both use the same WebRTC media engine for client-side processing.

### 5.2 Zoom optimization

| Platform | Zoom VDI plugin        | Media offload | Quality     |
| -------- | ---------------------- | ------------- | ----------- |
| AVD      | Yes (native support)   | Client-side   | Up to 1080p |
| Citrix   | Yes (HDX optimization) | Client-side   | Up to 1080p |

---

## 6. Printing performance

### 6.1 Print latency

Time from print command to first page output:

| Scenario                      | AVD (Universal Print) | AVD (redirected printer) | Citrix (Universal Print Driver) |
| ----------------------------- | --------------------- | ------------------------ | ------------------------------- |
| Local USB printer             | 3--5s                 | 2--4s                    | 2--4s                           |
| Network printer (same site)   | 4--8s                 | 5--10s                   | 4--8s                           |
| Network printer (remote site) | 8--15s                | 10--20s                  | 8--15s                          |

### 6.2 Large document printing

| Document                 | AVD (Universal Print) | Citrix (UPD) | Notes                                       |
| ------------------------ | --------------------- | ------------ | ------------------------------------------- |
| 10-page Word doc         | 5--8s                 | 4--7s        | Comparable                                  |
| 50-page PDF              | 15--25s               | 12--20s      | Comparable                                  |
| 100-page PDF with images | 30--60s               | 25--50s      | Citrix UPD slightly faster for complex docs |
| Large spreadsheet (5 MB) | 10--20s               | 8--15s       | Comparable                                  |

---

## 7. Scalability benchmarks

### 7.1 Host pool scaling

| Metric                               | AVD                       | Citrix (on Azure)         |
| ------------------------------------ | ------------------------- | ------------------------- |
| Max session hosts per pool           | 10,000                    | 10,000 (per Site)         |
| Scale-out time (start 10 VMs)        | 3--5 minutes              | 3--5 minutes              |
| Scale-out time (start 100 VMs)       | 5--10 minutes             | 5--10 minutes             |
| Scale-in (drain + deallocate 10 VMs) | 5--30 min (drain timeout) | 5--30 min (drain timeout) |
| Scaling plan evaluation interval     | 5 minutes                 | 5 minutes (Autoscale)     |

### 7.2 Profile storage IOPS

| Storage backend            | IOPS per user (login) | IOPS per user (steady) | Max concurrent logins           |
| -------------------------- | --------------------- | ---------------------- | ------------------------------- |
| Azure Files Premium (1 TB) | 10,000 base + burst   | 2--5 IOPS/user         | ~500 simultaneous (login storm) |
| Azure Files Premium (5 TB) | 50,000 base + burst   | 2--5 IOPS/user         | ~2,500 simultaneous             |
| Azure NetApp Files (4 TB)  | 65,536 max            | 2--5 IOPS/user         | ~3,000 simultaneous             |

---

## 8. Summary

| Metric                       | AVD advantage               | Citrix advantage                | Parity            |
| ---------------------------- | --------------------------- | ------------------------------- | ----------------- |
| User density (multi-session) | +40% (Windows 11 vs Server) |                                 |                   |
| Login time                   | +10--40s faster (FSLogix)   |                                 |                   |
| Protocol latency (UDP)       |                             | 10--15% lower (HDX)             |                   |
| GPU performance              |                             | 10--15% higher FPS (HDX 3D Pro) |                   |
| Teams optimization           |                             |                                 | Equivalent        |
| Printing                     |                             | Slightly faster (UPD)           | Nearly equivalent |
| Bandwidth efficiency         |                             | 10--20% lower (HDX compression) |                   |
| Scalability                  |                             |                                 | Equivalent        |
| Cost per user                | 63--67% lower               |                                 |                   |

**Bottom line:** AVD provides significantly higher density and faster login times. Citrix retains advantages in protocol optimization for graphics-intensive and extreme-low-bandwidth scenarios. For the majority of enterprise and federal workloads (knowledge workers, data analysts, task workers), AVD delivers better or equivalent performance at substantially lower cost.

---

## 9. CSA-in-a-Box data analyst workload benchmarks

### 9.1 Power BI Desktop performance

| Metric                             | AVD (D8s_v5, multi-session, 10 users) | Citrix SBC (D8s_v5, 7 users) |
| ---------------------------------- | ------------------------------------- | ---------------------------- |
| Report open (50 MB .pbix)          | 4--8 seconds                          | 5--10 seconds                |
| Visual render (complex dashboard)  | 1--3 seconds                          | 1--3 seconds                 |
| DAX query (1M rows)                | 2--5 seconds                          | 2--5 seconds                 |
| Direct Lake query (Fabric)         | 0.5--2 seconds                        | 0.5--2 seconds               |
| Memory per user (idle report open) | 800 MB--1.5 GB                        | 800 MB--1.5 GB               |
| CPU per user (interactive use)     | 10--20% of 1 vCPU                     | 10--20% of 1 vCPU            |

### 9.2 Azure Data Studio / Jupyter performance

| Metric                             | AVD (D8s_v5, multi-session)      | Citrix SBC (D8s_v5) |
| ---------------------------------- | -------------------------------- | ------------------- |
| Application launch                 | 3--5 seconds                     | 4--6 seconds        |
| SQL query (10K rows)               | 1--2 seconds (network dependent) | 1--2 seconds        |
| Jupyter notebook render (50 cells) | 2--4 seconds                     | 2--4 seconds        |
| Python execution (pandas, 1M rows) | 3--8 seconds (CPU bound)         | 3--8 seconds        |
| Memory per user (active notebook)  | 500 MB--2 GB                     | 500 MB--2 GB        |

### 9.3 Data analyst desktop density recommendation

Based on combined workload testing (Power BI + Azure Data Studio + Edge + Teams):

| VM size                  | Recommended max analysts | Memory per user | CPU per user |
| ------------------------ | ------------------------ | --------------- | ------------ |
| D4s_v5 (4 vCPU, 16 GB)   | 4--5                     | ~3 GB           | ~0.8 vCPU    |
| D8s_v5 (8 vCPU, 32 GB)   | 8--10                    | ~3 GB           | ~0.8 vCPU    |
| D16s_v5 (16 vCPU, 64 GB) | 16--20                   | ~3 GB           | ~0.8 vCPU    |
| E8s_v5 (8 vCPU, 64 GB)   | 10--14                   | ~4 GB           | ~0.6 vCPU    |

The E-series (memory-optimized) VMs are well-suited for data analysts who work with large in-memory datasets.

---

## 10. Benchmark methodology notes

### 10.1 Test tools used

- **Login VSI:** industry-standard VDI load generation and user experience measurement
- **Azure Monitor + AVD Insights:** production telemetry for real-world validation
- **PerfMon / Performance Monitor:** Windows performance counters for CPU, memory, disk, network
- **Wireshark + Protocol Analysis:** network-level protocol measurement for RTT and bandwidth
- **SPECviewperf 2020:** standardized graphics performance benchmark

### 10.2 Caveats

- All benchmarks are **indicative, not absolute**. Individual results vary based on workload mix, user behavior, network conditions, and configuration
- Citrix HDX performance depends heavily on Citrix Workspace app version and policy configuration
- AVD RDP Shortpath performance depends on network path quality and NAT traversal success
- GPU benchmarks depend on driver version and GPU partitioning configuration
- Login times depend on profile size, GPO complexity, and storage IOPS provisioning
- Teams optimization depends on client hardware (CPU, GPU, webcam quality)

### 10.3 How to run your own benchmarks

1. Deploy a pilot AVD environment (see [Tutorial: AVD Deployment](tutorial-avd-deployment.md))
2. Keep your existing Citrix environment running in parallel
3. Use Login VSI or a similar tool to generate comparable load on both platforms
4. Measure: login time, session host CPU/memory, user input delay, protocol RTT
5. Compare results side-by-side
6. Run for at least 5 business days to capture representative usage patterns

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
