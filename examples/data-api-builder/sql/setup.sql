-- =============================================================================
-- Data API Builder — SQL Server Schema for Data Mesh Sharing
-- CSA-in-a-Box | Tutorial 11
-- =============================================================================
-- This script creates the database schema, stored procedures, and seed data
-- for the Data API Builder (DAB) data-sharing layer.
-- Run against: Azure SQL Database or SQL Server 2019+
-- =============================================================================

-- ─── Domains ────────────────────────────────────────────────────────────────

CREATE TABLE dbo.Domains (
    id              INT             IDENTITY(1,1) PRIMARY KEY,
    name            NVARCHAR(100)   NOT NULL UNIQUE,
    description     NVARCHAR(500)   NULL,
    owner_team      NVARCHAR(200)   NOT NULL,
    product_count   INT             NOT NULL DEFAULT 0,
    created_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ─── Data Products ──────────────────────────────────────────────────────────

CREATE TABLE dbo.DataProducts (
    id                  INT             IDENTITY(1,1) PRIMARY KEY,
    name                NVARCHAR(200)   NOT NULL,
    description         NVARCHAR(2000)  NULL,
    domain              NVARCHAR(100)   NOT NULL,
    owner_name          NVARCHAR(200)   NOT NULL,
    owner_email         NVARCHAR(320)   NOT NULL,
    owner_team          NVARCHAR(200)   NOT NULL,
    classification      NVARCHAR(50)    NOT NULL DEFAULT 'internal',
    quality_score       DECIMAL(5,2)    NULL,
    freshness_hours     INT             NULL,
    completeness        DECIMAL(5,2)    NULL,
    availability        DECIMAL(5,2)    NULL DEFAULT 99.9,
    status              NVARCHAR(20)    NOT NULL DEFAULT 'draft',
    version             INT             NOT NULL DEFAULT 1,
    created_at          DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_DataProducts_Domain FOREIGN KEY (domain)
        REFERENCES dbo.Domains(name),
    CONSTRAINT CK_DataProducts_Status
        CHECK (status IN ('draft','active','deprecated','archived')),
    CONSTRAINT CK_DataProducts_Classification
        CHECK (classification IN ('public','internal','confidential','restricted'))
);
GO

CREATE NONCLUSTERED INDEX IX_DataProducts_Domain
    ON dbo.DataProducts(domain);
CREATE NONCLUSTERED INDEX IX_DataProducts_Status
    ON dbo.DataProducts(status);
GO

-- ─── Quality Metrics ────────────────────────────────────────────────────────

CREATE TABLE dbo.QualityMetrics (
    id              INT             IDENTITY(1,1) PRIMARY KEY,
    product_id      INT             NOT NULL,
    date            DATE            NOT NULL,
    quality_score   DECIMAL(5,2)    NOT NULL,
    completeness    DECIMAL(5,2)    NULL,
    freshness_hours INT             NULL,
    row_count       BIGINT          NULL,
    accuracy        DECIMAL(5,2)    NULL,
    consistency     DECIMAL(5,2)    NULL,
    created_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_QualityMetrics_Product FOREIGN KEY (product_id)
        REFERENCES dbo.DataProducts(id) ON DELETE CASCADE
);
GO

CREATE NONCLUSTERED INDEX IX_QualityMetrics_Product
    ON dbo.QualityMetrics(product_id, date DESC);
GO

-- ─── Access Grants ──────────────────────────────────────────────────────────

CREATE TABLE dbo.AccessGrants (
    id              INT             IDENTITY(1,1) PRIMARY KEY,
    product_id      INT             NOT NULL,
    requester_email NVARCHAR(320)   NOT NULL,
    access_level    NVARCHAR(20)    NOT NULL DEFAULT 'read',
    status          NVARCHAR(20)    NOT NULL DEFAULT 'pending',
    justification   NVARCHAR(1000)  NULL,
    granted_at      DATETIME2       NULL,
    expires_at      DATETIME2       NULL,
    granted_by      NVARCHAR(200)   NULL,
    created_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_AccessGrants_Product FOREIGN KEY (product_id)
        REFERENCES dbo.DataProducts(id) ON DELETE CASCADE,
    CONSTRAINT CK_AccessGrants_Level
        CHECK (access_level IN ('read','write','admin')),
    CONSTRAINT CK_AccessGrants_Status
        CHECK (status IN ('pending','approved','denied','revoked','expired'))
);
GO

-- ─── Data Lineage ───────────────────────────────────────────────────────────

CREATE TABLE dbo.DataLineage (
    id                  INT             IDENTITY(1,1) PRIMARY KEY,
    source_product_id   INT             NOT NULL,
    target_product_id   INT             NOT NULL,
    transformation      NVARCHAR(500)   NULL,
    pipeline_name       NVARCHAR(200)   NULL,
    created_at          DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_DataLineage_Source FOREIGN KEY (source_product_id)
        REFERENCES dbo.DataProducts(id),
    CONSTRAINT FK_DataLineage_Target FOREIGN KEY (target_product_id)
        REFERENCES dbo.DataProducts(id),
    CONSTRAINT CK_DataLineage_NoSelfRef
        CHECK (source_product_id <> target_product_id)
);
GO

-- ─── Stored Procedures ─────────────────────────────────────────────────────

CREATE OR ALTER PROCEDURE dbo.sp_domain_stats
AS
BEGIN
    SET NOCOUNT ON;
    SELECT
        d.name              AS domain_name,
        d.owner_team,
        d.product_count,
        COUNT(dp.id)        AS active_products,
        AVG(dp.quality_score) AS avg_quality_score,
        MIN(dp.quality_score) AS min_quality_score,
        MAX(dp.quality_score) AS max_quality_score
    FROM dbo.Domains d
    LEFT JOIN dbo.DataProducts dp
        ON dp.domain = d.name AND dp.status = 'active'
    GROUP BY d.name, d.owner_team, d.product_count
    ORDER BY d.name;
END;
GO

CREATE OR ALTER PROCEDURE dbo.sp_quality_trend
    @product_id INT,
    @days       INT = 30
AS
BEGIN
    SET NOCOUNT ON;
    SELECT
        date,
        quality_score,
        completeness,
        freshness_hours,
        row_count,
        accuracy,
        consistency
    FROM dbo.QualityMetrics
    WHERE product_id = @product_id
      AND date >= DATEADD(DAY, -@days, CAST(SYSUTCDATETIME() AS DATE))
    ORDER BY date;
END;
GO

-- ─── Seed Data: Domains ─────────────────────────────────────────────────────

INSERT INTO dbo.Domains (name, description, owner_team, product_count) VALUES
('finance',     'Financial reporting and revenue data',      'Finance Data Team',     2),
('operations',  'Supply chain and logistics data',           'Ops Analytics Team',    1),
('marketing',   'Campaign and customer engagement data',     'Marketing Insights',    1),
('hr',          'Workforce and talent analytics',            'People Analytics Team', 1);
GO

-- ─── Seed Data: Data Products ───────────────────────────────────────────────

INSERT INTO dbo.DataProducts (name, description, domain, owner_name, owner_email, owner_team, classification, quality_score, freshness_hours, completeness, availability, status, version) VALUES
('Revenue Summary',        'Aggregated revenue by region and quarter',          'finance',    'Alice Chen',    'alice@contoso.com',   'Finance Data Team',     'confidential', 92.5,  24, 97.0, 99.9, 'active', 2),
('Budget Forecast',        'Annual budget projections by department',           'finance',    'Bob Martinez',  'bob@contoso.com',     'Finance Data Team',     'restricted',   88.1,  48, 94.5, 99.5, 'active', 1),
('Shipment Tracker',       'Real-time shipment status and delivery metrics',    'operations', 'Carol Davis',   'carol@contoso.com',   'Ops Analytics Team',    'internal',     85.3,   1, 91.2, 99.0, 'active', 3),
('Campaign Performance',   'Marketing campaign ROI and engagement metrics',     'marketing',  'Dan Wilson',    'dan@contoso.com',     'Marketing Insights',    'internal',     78.9,  12, 88.0, 98.5, 'active', 1),
('Workforce Demographics', 'Employee demographics and diversity metrics',       'hr',         'Eva Johnson',   'eva@contoso.com',     'People Analytics Team', 'restricted',   91.0,  72, 96.3, 99.7, 'draft',  1);
GO

-- ─── Seed Data: Quality Metrics (30 records across products) ────────────────

DECLARE @i INT = 0;
WHILE @i < 6
BEGIN
    INSERT INTO dbo.QualityMetrics (product_id, date, quality_score, completeness, freshness_hours, row_count, accuracy, consistency) VALUES
    (1, DATEADD(DAY, -@i * 5, CAST(SYSUTCDATETIME() AS DATE)), 92.5 - @i * 0.3, 97.0 - @i * 0.2, 24, 125000 + @i * 500,  94.0, 96.5),
    (2, DATEADD(DAY, -@i * 5, CAST(SYSUTCDATETIME() AS DATE)), 88.1 - @i * 0.5, 94.5 - @i * 0.3, 48, 45000  + @i * 200,  90.2, 93.1),
    (3, DATEADD(DAY, -@i * 5, CAST(SYSUTCDATETIME() AS DATE)), 85.3 + @i * 0.2, 91.2 + @i * 0.1,  1, 980000 + @i * 10000, 87.5, 89.0),
    (4, DATEADD(DAY, -@i * 5, CAST(SYSUTCDATETIME() AS DATE)), 78.9 + @i * 0.4, 88.0 + @i * 0.3, 12, 67000  + @i * 1000,  82.1, 85.7),
    (5, DATEADD(DAY, -@i * 5, CAST(SYSUTCDATETIME() AS DATE)), 91.0 - @i * 0.1, 96.3 - @i * 0.1, 72, 15000  + @i * 100,  93.8, 95.2);
    SET @i = @i + 1;
END;
GO

-- ─── Seed Data: Access Grants ───────────────────────────────────────────────

INSERT INTO dbo.AccessGrants (product_id, requester_email, access_level, status, justification, granted_at, expires_at, granted_by) VALUES
(1, 'analyst@contoso.com',  'read',  'approved', 'Quarterly board report preparation',              SYSUTCDATETIME(), DATEADD(MONTH, 6, SYSUTCDATETIME()), 'alice@contoso.com'),
(3, 'manager@contoso.com',  'read',  'approved', 'Supply chain dashboard',                          SYSUTCDATETIME(), DATEADD(MONTH, 12, SYSUTCDATETIME()), 'carol@contoso.com'),
(1, 'external@partner.com', 'read',  'pending',  'Due diligence for partnership evaluation',         NULL,             NULL,                                 NULL);
GO

-- ─── Update Domain Product Counts ───────────────────────────────────────────

UPDATE d SET d.product_count = counts.cnt
FROM dbo.Domains d
INNER JOIN (
    SELECT domain, COUNT(*) AS cnt
    FROM dbo.DataProducts
    WHERE status IN ('active','draft')
    GROUP BY domain
) counts ON d.name = counts.domain;
GO

PRINT 'DAB schema and seed data created successfully.';
GO
