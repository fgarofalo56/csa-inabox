/**
 * Shared notebook argument/runtime compatibility preamble.
 *
 * Extracted verbatim from the supercharge medallion content bundles
 * (bronze/silver/gold) where this Fabric/local compatibility shim was embedded
 * identically at the top of many notebook code cells. Kept as an exact escaped
 * string so the composed cell `source` values remain BYTE-IDENTICAL to the
 * pre-refactor generated output. Do not edit — it must match the shim emitted
 * by scripts/csa-loom/import-supercharge-notebooks.mjs.
 */
export const NOTEBOOK_ARG_PREAMBLE = "# ---------------------------------------------------------------------------\n# Fabric/local compatibility shim\n# ---------------------------------------------------------------------------\nimport os\n\ntry:\n    import notebookutils  # Fabric runtime\n    def _get_arg(name, default=None):\n        try:\n            return notebookutils.notebook.getArgument(name, default)\n        except Exception:\n            return os.environ.get(name.upper(), default)\n    def _notebook_exit(status: str) -> None:\n        notebookutils.notebook.exit(status)\nexcept ImportError:\n    try:\n        import mssparkutils  # legacy Synapse/Fabric runtime\n        def _get_arg(name, default=None):\n            try:\n                return mssparkutils.notebook.getArgument(name, default)\n            except Exception:\n                return os.environ.get(name.upper(), default)\n        def _notebook_exit(status: str) -> None:\n            mssparkutils.notebook.exit(status)\n    except ImportError:\n        def _get_arg(name, default=None):\n            return os.environ.get(name.upper(), default)\n        def _notebook_exit(status: str) -> None:\n            raise SystemExit(status)\n\n\n";
