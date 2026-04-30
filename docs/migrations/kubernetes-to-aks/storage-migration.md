# Storage Migration: Persistent Volumes to Azure CSI Drivers

**Status:** Authored 2026-04-30
**Audience:** Platform engineers and storage administrators migrating persistent storage from on-premises Kubernetes clusters to AKS.
**Scope:** CSI drivers (Azure Disk, Azure Files, Azure Blob, Azure NetApp Files), storage class mapping, StatefulSet migration, and data migration strategies.

---

## 1. Storage landscape mapping

### Source storage to Azure storage mapping

| Source storage                          | Azure equivalent                           | CSI driver                                                  | Access modes | Use case                            |
| --------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- | ------------ | ----------------------------------- |
| **Ceph RBD** (block)                    | Azure Managed Disk                         | `disk.csi.azure.com`                                        | RWO          | Databases, single-writer workloads  |
| **CephFS** (filesystem)                 | Azure Files NFS                            | `file.csi.azure.com`                                        | RWX          | Shared data, multi-reader workloads |
| **GlusterFS**                           | Azure Files SMB/NFS                        | `file.csi.azure.com`                                        | RWX          | Legacy shared storage               |
| **NFS server** (in-cluster or external) | Azure Files NFS / Azure NetApp Files       | `file.csi.azure.com` / `anetappfiles.csi.trident.netapp.io` | RWX          | High-performance NFS                |
| **Local NVMe / hostPath**               | Azure Ultra Disk or local NVMe (LSv3/Lsv2) | `disk.csi.azure.com` or host path                           | RWO          | Low-latency databases               |
| **Longhorn**                            | Azure Managed Disk                         | `disk.csi.azure.com`                                        | RWO          | Block storage replacement           |
| **OpenEBS**                             | Azure Managed Disk                         | `disk.csi.azure.com`                                        | RWO          | Block storage replacement           |
| **vSphere VMDK**                        | Azure Managed Disk                         | `disk.csi.azure.com`                                        | RWO          | VMware storage migration            |
| **iSCSI**                               | Azure Managed Disk                         | `disk.csi.azure.com`                                        | RWO          | SAN replacement                     |
| **AWS EBS**                             | Azure Managed Disk                         | `disk.csi.azure.com`                                        | RWO          | Cross-cloud migration               |

---

## 2. Azure Disk CSI driver

Azure Disk provides block storage for single-writer workloads (databases, message queues, application state).

### Storage classes

```yaml
# Premium SSD (recommended for production)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: managed-csi-premium
provisioner: disk.csi.azure.com
parameters:
    skuName: Premium_LRS
    cachingMode: ReadOnly # ReadWrite for write-heavy, None for Ultra
reclaimPolicy: Retain # Retain for production data
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true

---
# Premium SSD v2 (sub-millisecond latency)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: managed-csi-premiumv2
provisioner: disk.csi.azure.com
parameters:
    skuName: PremiumV2_LRS
    cachingMode: None # v2 does not support host caching
    DiskIOPSReadWrite: "5000"
    DiskMBpsReadWrite: "200"
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true

---
# Ultra Disk (extreme IOPS)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: managed-csi-ultra
provisioner: disk.csi.azure.com
parameters:
    skuName: UltraSSD_LRS
    DiskIOPSReadWrite: "10000"
    DiskMBpsReadWrite: "400"
    cachingMode: None
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true

---
# Zone-redundant storage (HA across zones)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: managed-csi-premium-zrs
provisioner: disk.csi.azure.com
parameters:
    skuName: Premium_ZRS
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

### Disk performance tiers

| SKU                   | IOPS (max) | Throughput (max) | Latency | Best for                   |
| --------------------- | ---------- | ---------------- | ------- | -------------------------- |
| Standard HDD          | 500        | 60 MBps          | ~10ms   | Dev/test, backups          |
| Standard SSD          | 6,000      | 750 MBps         | ~6ms    | Light production           |
| Premium SSD (P30 1TB) | 5,000      | 200 MBps         | ~2ms    | Most production databases  |
| Premium SSD v2        | 80,000     | 1,200 MBps       | <1ms    | High-performance databases |
| Ultra Disk            | 160,000    | 4,000 MBps       | <1ms    | Extreme IOPS workloads     |

---

## 3. Azure Files CSI driver

Azure Files provides shared storage for multi-reader/multi-writer workloads (shared configuration, CMS content, ML model artifacts).

### Storage classes

```yaml
# Azure Files NFS (Linux, no SMB overhead)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: azurefile-csi-nfs-premium
provisioner: file.csi.azure.com
parameters:
    protocol: nfs
    skuName: Premium_LRS
mountOptions:
    - nconnect=4
    - noresvport
    - actimeo=30
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: true

---
# Azure Files SMB (Windows or Linux)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: azurefile-csi-premium
provisioner: file.csi.azure.com
parameters:
    skuName: Premium_LRS
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: true
```

---

## 4. Azure Blob CSI driver

Azure Blob provides object storage mounted as a filesystem using BlobFuse2 or NFS v3.

```yaml
# Azure Blob with BlobFuse2
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: blob-fuse-premium
provisioner: blob.csi.azure.com
parameters:
    skuName: Premium_LRS
    protocol: fuse2
    isHnsEnabled: "true" # Hierarchical namespace (ADLS Gen2)
reclaimPolicy: Retain
volumeBindingMode: Immediate
```

Use cases for Blob CSI:

- Mounting ADLS Gen2 containers directly into pods (for data processing)
- ML training data access (large datasets, sequential reads)
- Log aggregation (write-heavy, cheap storage)

---

## 5. Azure NetApp Files

Azure NetApp Files provides enterprise-grade NFS/SMB with sub-millisecond latency.

```yaml
# Azure NetApp Files (Trident CSI)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: anf-premium
provisioner: csi.trident.netapp.io
parameters:
    backendType: azure-netapp-files
    serviceLevel: Premium
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: true
```

Use Azure NetApp Files when:

- Sub-millisecond NFS latency is required
- Enterprise NFS features needed (snapshots, clones, cross-region replication)
- Migrating from on-prem NetApp arrays
- SAP, Oracle, or other enterprise applications requiring certified NFS

---

## 6. Storage class mapping reference

| On-prem storage class            | AKS storage class                          | CSI driver        | Notes                                                 |
| -------------------------------- | ------------------------------------------ | ----------------- | ----------------------------------------------------- |
| `ceph-block` / `rook-ceph-block` | `managed-csi-premium`                      | Azure Disk        | Block storage 1:1                                     |
| `cephfs` / `rook-cephfs`         | `azurefile-csi-nfs-premium`                | Azure Files NFS   | Shared filesystem                                     |
| `nfs-client` / `nfs-provisioner` | `azurefile-csi-nfs-premium`                | Azure Files NFS   | NFS replacement                                       |
| `local-path`                     | `managed-csi-premium` or ephemeral volumes | Azure Disk        | Persistent replaces local-path                        |
| `hostpath`                       | Ephemeral volume or Azure Disk             | N/A or Azure Disk | Use emptyDir for ephemeral; Azure Disk for persistent |
| `glusterfs`                      | `azurefile-csi-premium`                    | Azure Files SMB   | Shared filesystem                                     |
| `longhorn`                       | `managed-csi-premium`                      | Azure Disk        | Block storage                                         |
| `openebs-cstor` / `openebs-jiva` | `managed-csi-premium`                      | Azure Disk        | Block storage                                         |
| `vsphere-volume`                 | `managed-csi-premium`                      | Azure Disk        | VMware migration                                      |

---

## 7. StatefulSet migration

StatefulSets require special attention because they maintain stable storage identity across pod restarts.

### Migration approach 1: Velero backup/restore

```bash
# On source cluster: backup the StatefulSet namespace
velero backup create postgres-backup \
  --include-namespaces databases \
  --include-resources statefulsets,pods,persistentvolumeclaims,persistentvolumes,services,secrets,configmaps \
  --default-volumes-to-fs-backup=true \
  --wait

# On AKS: create storage class mapping
cat > storage-class-mapping.yaml << 'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: change-storage-class-config
  namespace: velero
  labels:
    velero.io/plugin-config: ""
    velero.io/change-storage-class: RestoreItemAction
data:
  ceph-block: managed-csi-premium
  rook-ceph-block: managed-csi-premium
  nfs-client: azurefile-csi-nfs-premium
EOF
kubectl apply -f storage-class-mapping.yaml

# Restore on AKS
velero restore create postgres-restore \
  --from-backup postgres-backup \
  --wait
```

### Migration approach 2: Application-level replication

For databases with built-in replication (PostgreSQL, MongoDB, Redis):

1. Deploy StatefulSet on AKS with empty PVCs
2. Configure source database to replicate to AKS replica
3. Wait for replication to catch up (lag = 0)
4. Promote AKS replica to primary
5. Update application connections to AKS endpoint
6. Decommission source database

```bash
# Example: PostgreSQL streaming replication
# On AKS: configure standby to stream from on-prem primary
cat > recovery.conf << 'EOF'
standby_mode = 'on'
primary_conninfo = 'host=postgres.onprem.internal port=5432 user=replicator password=xxx sslmode=require'
trigger_file = '/tmp/promote'
EOF

# When ready to cutover:
kubectl exec -n databases postgres-0 -- touch /tmp/promote
```

### Migration approach 3: rsync-based data copy

For workloads where Velero and replication are not available:

```bash
# Create PVC on AKS
kubectl apply -f pvc-aks.yaml

# Deploy rsync pod on AKS
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: rsync-receiver
  namespace: databases
spec:
  containers:
    - name: rsync
      image: csainaboxacr.azurecr.io/tools/rsync:latest
      command: ["rsync", "--daemon"]
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: postgres-data-aks
EOF

# From source cluster: rsync data to AKS
rsync -avz --progress /data/ rsync://rsync-receiver.databases.svc.cluster.local/data/
```

---

## 8. Data migration strategies comparison

| Strategy                    | Downtime                                | Data volume | Complexity | Best for                              |
| --------------------------- | --------------------------------------- | ----------- | ---------- | ------------------------------------- |
| **Velero backup/restore**   | Minutes to hours (depends on data size) | Any         | Low        | General-purpose, well-supported       |
| **Application replication** | Seconds (near-zero)                     | Any         | Medium     | Databases with built-in replication   |
| **rsync**                   | Proportional to data size               | < 1 TB      | Low        | Simple file-based data                |
| **AzCopy**                  | Proportional to data size               | Any         | Low        | Blob/file data to Azure Storage       |
| **Azure Data Box**          | Days (ship + import)                    | > 10 TB     | Low        | Massive data sets                     |
| **CSI volume snapshots**    | Minutes                                 | < 500 GB    | Low        | Snapshot-based migration within Azure |

---

## 9. Volume snapshot support

AKS supports CSI volume snapshots for Azure Disk:

```yaml
# VolumeSnapshotClass
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
    name: csi-azuredisk-vsc
driver: disk.csi.azure.com
deletionPolicy: Retain
parameters:
    incremental: "true"

---
# Create a snapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
    name: postgres-snapshot
    namespace: databases
spec:
    volumeSnapshotClassName: csi-azuredisk-vsc
    source:
        persistentVolumeClaimName: pgdata-postgres-0

---
# Restore from snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
    name: pgdata-postgres-restored
    namespace: databases
spec:
    storageClassName: managed-csi-premium
    dataSource:
        name: postgres-snapshot
        kind: VolumeSnapshot
        apiGroup: snapshot.storage.k8s.io
    accessModes:
        - ReadWriteOnce
    resources:
        requests:
            storage: 100Gi
```

---

## 10. Storage migration validation

After migrating storage, validate:

- [ ] PVCs bound and correct size (`kubectl get pvc -A`)
- [ ] Storage class correct (`kubectl get pvc -o wide`)
- [ ] Data integrity verified (checksums, row counts, file counts)
- [ ] IOPS and throughput meet application requirements (benchmark with `fio`)
- [ ] Volume expansion works (`kubectl edit pvc` to increase size)
- [ ] Backup and restore tested (Velero or snapshot-based)
- [ ] Multi-attach works for RWX volumes (if applicable)
- [ ] Mount options correct for NFS volumes
- [ ] Encryption at rest enabled (Azure default: SSE with platform-managed keys)
- [ ] Zone redundancy configured for HA workloads (ZRS storage classes)

```bash
# Quick storage benchmark with fio
kubectl run fio-test --image=csainaboxacr.azurecr.io/tools/fio:latest --rm -it \
  --overrides='{"spec":{"containers":[{"name":"fio","image":"csainaboxacr.azurecr.io/tools/fio:latest","command":["fio","--name=randwrite","--ioengine=libaio","--direct=1","--bs=4k","--numjobs=4","--size=1G","--runtime=60","--rw=randwrite","--filename=/data/test"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"test-pvc"}}]}}' \
  -- /bin/sh
```

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
**Related:** [Cluster Migration](cluster-migration.md) | [Workload Migration](workload-migration.md) | [Tutorial: Velero Migration](tutorial-velero-migration.md)
