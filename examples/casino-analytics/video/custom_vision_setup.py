#!/usr/bin/env python3
"""
Custom Vision Model Setup for Casino Floor Analytics

Sets up and manages Azure Custom Vision models for:
  1. Crowd density estimation (person detection + spatial clustering)
  2. Queue length detection (person counting in defined zones)
  3. Table occupancy classification (seat occupancy detection)

This script handles:
  - Custom Vision project creation and configuration
  - Training image upload and tagging
  - Model training iteration management
  - Model export for edge deployment (ONNX / Docker)
  - Performance evaluation and threshold tuning

Usage:
    python custom_vision_setup.py create-project --name "Casino Floor Density"
    python custom_vision_setup.py upload-images --project-id $ID --image-dir ./training-data
    python custom_vision_setup.py train --project-id $ID
    python custom_vision_setup.py export --project-id $ID --iteration-id $ITER --platform onnx
    python custom_vision_setup.py evaluate --project-id $ID --iteration-id $ITER
    python custom_vision_setup.py --help

Prerequisites:
    pip install azure-cognitiveservices-vision-customvision msrest Pillow

Environment Variables:
    CUSTOM_VISION_TRAINING_KEY       - Training resource key
    CUSTOM_VISION_TRAINING_ENDPOINT  - Training endpoint URL
    CUSTOM_VISION_PREDICTION_KEY     - Prediction resource key
    CUSTOM_VISION_PREDICTION_ENDPOINT - Prediction endpoint URL
    CUSTOM_VISION_PREDICTION_ID      - Prediction resource ID
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Model configuration
# ---------------------------------------------------------------------------

# Casino floor detection models
MODEL_CONFIGS = {
    "crowd-density": {
        "name": "Casino Floor Crowd Density",
        "description": "Person detection for crowd density estimation across casino floor zones",
        "domain": "ObjectDetection",
        "classification_type": None,
        "tags": [
            {"name": "person", "description": "Standing or walking person"},
            {"name": "seated_person", "description": "Person seated at machine or table"},
            {"name": "staff", "description": "Casino staff member (uniform detected)"},
        ],
        "export_platforms": ["ONNX", "DockerFile"],
        "target_metrics": {
            "precision": 0.85,
            "recall": 0.80,
            "mAP": 0.80,
        },
    },
    "queue-detection": {
        "name": "Casino Queue Length Detection",
        "description": "Person counting in queue zones at cage, cashier, and service areas",
        "domain": "ObjectDetection",
        "classification_type": None,
        "tags": [
            {"name": "person_in_queue", "description": "Person standing in queue"},
            {"name": "service_window", "description": "Service window/counter"},
            {"name": "queue_barrier", "description": "Queue rope/stanchion"},
        ],
        "export_platforms": ["ONNX", "DockerFile"],
        "target_metrics": {
            "precision": 0.88,
            "recall": 0.85,
            "mAP": 0.83,
        },
    },
    "table-occupancy": {
        "name": "Casino Table Occupancy",
        "description": "Classify table game occupancy status for floor management",
        "domain": "Classification",
        "classification_type": "Multiclass",
        "tags": [
            {"name": "empty", "description": "Table with no players"},
            {"name": "partial", "description": "Table with 1-3 players"},
            {"name": "busy", "description": "Table with 4-5 players"},
            {"name": "full", "description": "Table at capacity"},
            {"name": "closed", "description": "Table closed/covered"},
        ],
        "export_platforms": ["ONNX", "DockerFile"],
        "target_metrics": {
            "precision": 0.90,
            "recall": 0.88,
            "mAP": None,
        },
    },
}


# ---------------------------------------------------------------------------
# Custom Vision Manager
# ---------------------------------------------------------------------------
class CustomVisionManager:
    """Manage Custom Vision projects for casino floor analytics."""

    def __init__(
        self,
        training_key: str,
        training_endpoint: str,
        prediction_key: str = "",
        prediction_endpoint: str = "",
        prediction_resource_id: str = "",
    ):
        """Initialize Custom Vision manager.

        Args:
            training_key: Training API key.
            training_endpoint: Training endpoint URL.
            prediction_key: Prediction API key.
            prediction_endpoint: Prediction endpoint URL.
            prediction_resource_id: Prediction resource ID for publishing.
        """
        self.training_key = training_key
        self.training_endpoint = training_endpoint
        self.prediction_key = prediction_key
        self.prediction_endpoint = prediction_endpoint
        self.prediction_resource_id = prediction_resource_id

        self.trainer = None
        self.predictor = None

    def connect(self):
        """Initialize Custom Vision SDK clients."""
        try:
            from azure.cognitiveservices.vision.customvision.training import (
                CustomVisionTrainingClient,
            )
            from azure.cognitiveservices.vision.customvision.prediction import (
                CustomVisionPredictionClient,
            )
            from msrest.authentication import ApiKeyCredentials

            training_credentials = ApiKeyCredentials(
                in_headers={"Training-key": self.training_key}
            )
            self.trainer = CustomVisionTrainingClient(
                self.training_endpoint, training_credentials
            )

            if self.prediction_key:
                prediction_credentials = ApiKeyCredentials(
                    in_headers={"Prediction-key": self.prediction_key}
                )
                self.predictor = CustomVisionPredictionClient(
                    self.prediction_endpoint, prediction_credentials
                )

            logger.info("Connected to Custom Vision service")

        except ImportError:
            logger.error(
                "Required packages not installed. Run:\n"
                "  pip install azure-cognitiveservices-vision-customvision msrest"
            )
            raise

    def create_project(self, model_type: str) -> Dict[str, Any]:
        """Create a Custom Vision project.

        Args:
            model_type: One of: crowd-density, queue-detection, table-occupancy

        Returns:
            Dict with project_id, name, tags created.
        """
        if model_type not in MODEL_CONFIGS:
            raise ValueError(
                f"Unknown model type: {model_type}. "
                f"Choose from: {list(MODEL_CONFIGS.keys())}"
            )

        config = MODEL_CONFIGS[model_type]

        # Get available domains
        domains = self.trainer.get_domains()

        if config["domain"] == "ObjectDetection":
            domain = next(
                (d for d in domains if d.type == "ObjectDetection" and "Compact" in d.name),
                next(d for d in domains if d.type == "ObjectDetection"),
            )
        else:
            domain = next(
                (d for d in domains if d.type == "Classification" and "Compact" in d.name),
                next(d for d in domains if d.type == "Classification"),
            )

        # Create project
        kwargs = {
            "name": config["name"],
            "description": config["description"],
            "domain_id": domain.id,
        }
        if config["classification_type"]:
            kwargs["classification_type"] = config["classification_type"]

        project = self.trainer.create_project(**kwargs)
        logger.info("Created project: %s (ID: %s)", project.name, project.id)

        # Create tags
        created_tags = []
        for tag_info in config["tags"]:
            tag = self.trainer.create_tag(
                project.id,
                tag_info["name"],
                description=tag_info["description"],
            )
            created_tags.append({"name": tag.name, "id": str(tag.id)})
            logger.info("  Created tag: %s", tag.name)

        result = {
            "project_id": str(project.id),
            "name": project.name,
            "domain": domain.name,
            "tags": created_tags,
            "model_type": model_type,
        }

        logger.info("Project setup complete: %s", json.dumps(result, indent=2))
        return result

    def upload_images(
        self,
        project_id: str,
        image_dir: str,
        batch_size: int = 64,
    ) -> Dict[str, int]:
        """Upload training images with region annotations.

        Expected directory structure:
            image_dir/
              images/           # Image files (.jpg, .png)
              annotations/      # Annotation files (.json per image)
              labels.json       # Tag name to tag ID mapping

        Args:
            project_id: Custom Vision project ID.
            image_dir: Path to training data directory.
            batch_size: Images per upload batch.

        Returns:
            Dict with upload statistics.
        """
        from azure.cognitiveservices.vision.customvision.training.models import (
            ImageFileCreateBatch,
            ImageFileCreateEntry,
            Region,
        )

        image_path = Path(image_dir) / "images"
        annotation_path = Path(image_dir) / "annotations"
        labels_path = Path(image_dir) / "labels.json"

        if not image_path.exists():
            raise FileNotFoundError(f"Image directory not found: {image_path}")

        # Load label mapping
        tag_map = {}
        if labels_path.exists():
            with open(labels_path) as f:
                tag_map = json.load(f)
        else:
            # Auto-discover tags from project
            tags = self.trainer.get_tags(project_id)
            tag_map = {t.name: str(t.id) for t in tags}

        logger.info("Tag mapping: %s", tag_map)

        # Collect image files
        image_files = sorted(
            p for p in image_path.iterdir()
            if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".bmp")
        )
        logger.info("Found %d images in %s", len(image_files), image_path)

        stats = {"uploaded": 0, "skipped": 0, "errors": 0}

        for i in range(0, len(image_files), batch_size):
            batch_files = image_files[i : i + batch_size]
            entries = []

            for img_file in batch_files:
                ann_file = annotation_path / f"{img_file.stem}.json"

                with open(img_file, "rb") as img_fh:
                    image_data = img_fh.read()

                regions = []
                tag_ids = []

                if ann_file.exists():
                    with open(ann_file) as ann_fh:
                        annotations = json.load(ann_fh)

                    for ann in annotations.get("regions", []):
                        tag_name = ann.get("tag", "")
                        tag_id = tag_map.get(tag_name)
                        if tag_id:
                            regions.append(Region(
                                tag_id=tag_id,
                                left=ann["left"],
                                top=ann["top"],
                                width=ann["width"],
                                height=ann["height"],
                            ))

                    for tag_name in annotations.get("tags", []):
                        tag_id = tag_map.get(tag_name)
                        if tag_id:
                            tag_ids.append(tag_id)

                entry = ImageFileCreateEntry(
                    name=img_file.name,
                    contents=image_data,
                    regions=regions if regions else None,
                    tag_ids=tag_ids if tag_ids else None,
                )
                entries.append(entry)

            try:
                batch = ImageFileCreateBatch(images=entries)
                result = self.trainer.create_images_from_files(project_id, batch)

                if result.is_batch_successful:
                    stats["uploaded"] += len(entries)
                else:
                    for img in result.images:
                        if img.status == "OK" or img.status == "OKDuplicate":
                            stats["uploaded"] += 1
                        else:
                            stats["errors"] += 1
                            logger.warning("Failed: %s - %s", img.source_url, img.status)

                logger.info("Batch %d-%d: uploaded", i, i + len(batch_files))

            except Exception as exc:
                stats["errors"] += len(entries)
                logger.error("Batch upload failed: %s", exc)

        logger.info("Upload complete: %s", stats)
        return stats

    def train(
        self,
        project_id: str,
        training_type: str = "Regular",
        reserved_budget_hours: int = 1,
    ) -> Dict[str, Any]:
        """Start model training.

        Args:
            project_id: Custom Vision project ID.
            training_type: "Regular" or "Advanced".
            reserved_budget_hours: Max training hours for Advanced.

        Returns:
            Dict with iteration details.
        """
        logger.info("Starting %s training for project %s", training_type, project_id)

        kwargs = {
            "project_id": project_id,
            "training_type": training_type,
            "force_train": True,
        }
        if training_type == "Advanced":
            kwargs["reserved_budget_in_hours"] = reserved_budget_hours

        iteration = self.trainer.train_project(**kwargs)
        logger.info("Training started: iteration %s", iteration.id)

        # Poll for completion
        while iteration.status == "Training":
            logger.info("Training in progress... (status: %s)", iteration.status)
            time.sleep(30)
            iteration = self.trainer.get_iteration(project_id, iteration.id)

        if iteration.status == "Completed":
            logger.info("Training completed successfully!")

            performance = self.trainer.get_iteration_performance(
                project_id, iteration.id
            )
            result = {
                "iteration_id": str(iteration.id),
                "status": iteration.status,
                "precision": performance.precision,
                "recall": performance.recall,
                "average_precision": getattr(performance, "average_precision", None),
                "trained_at": iteration.trained_at.isoformat() if iteration.trained_at else None,
            }

            logger.info("Performance: %s", json.dumps(result, indent=2))
            return result
        else:
            logger.error("Training failed with status: %s", iteration.status)
            return {
                "iteration_id": str(iteration.id),
                "status": iteration.status,
                "error": "Training did not complete successfully",
            }

    def export_model(
        self,
        project_id: str,
        iteration_id: str,
        platform: str = "ONNX",
    ) -> Dict[str, Any]:
        """Export trained model for edge deployment.

        Args:
            project_id: Custom Vision project ID.
            iteration_id: Training iteration ID.
            platform: Export platform (ONNX, DockerFile, TensorFlow).

        Returns:
            Dict with export download URL.
        """
        logger.info("Exporting model: platform=%s", platform)

        flavor = None
        if platform == "ONNX":
            flavor = "OnnxFloat16"
        elif platform == "DockerFile":
            flavor = "Linux"

        try:
            self.trainer.export_iteration(
                project_id,
                iteration_id,
                platform=platform,
                flavor=flavor,
            )
        except Exception as exc:
            if "already exists" not in str(exc).lower():
                raise

        # Poll for export completion
        for _ in range(30):
            exports = self.trainer.get_exports(project_id, iteration_id)
            export = next(
                (e for e in exports if e.platform == platform),
                None,
            )

            if export and export.status == "Done":
                result = {
                    "platform": platform,
                    "status": "Done",
                    "download_uri": export.download_uri,
                    "flavor": flavor,
                }
                logger.info("Export ready: %s", export.download_uri)
                return result

            time.sleep(10)

        return {"platform": platform, "status": "Timeout", "download_uri": None}

    def evaluate(
        self,
        project_id: str,
        iteration_id: str,
        model_type: str = "crowd-density",
    ) -> Dict[str, Any]:
        """Evaluate model against target metrics.

        Args:
            project_id: Custom Vision project ID.
            iteration_id: Training iteration ID.
            model_type: Model config key for target metrics.

        Returns:
            Dict with evaluation results and pass/fail status.
        """
        config = MODEL_CONFIGS.get(model_type, {})
        targets = config.get("target_metrics", {})

        performance = self.trainer.get_iteration_performance(
            project_id, iteration_id
        )

        results = {
            "iteration_id": iteration_id,
            "precision": performance.precision,
            "recall": performance.recall,
            "target_precision": targets.get("precision"),
            "target_recall": targets.get("recall"),
        }

        all_pass = True

        if targets.get("precision") and performance.precision < targets["precision"]:
            all_pass = False
            results["precision_status"] = "BELOW_TARGET"
        else:
            results["precision_status"] = "PASS"

        if targets.get("recall") and performance.recall < targets["recall"]:
            all_pass = False
            results["recall_status"] = "BELOW_TARGET"
        else:
            results["recall_status"] = "PASS"

        if hasattr(performance, "average_precision") and targets.get("mAP"):
            results["mAP"] = performance.average_precision
            results["target_mAP"] = targets["mAP"]
            if performance.average_precision < targets["mAP"]:
                all_pass = False
                results["mAP_status"] = "BELOW_TARGET"
            else:
                results["mAP_status"] = "PASS"

        # Per-tag performance
        per_tag = []
        for tag_perf in performance.per_tag_performance:
            per_tag.append({
                "tag": tag_perf.name,
                "precision": tag_perf.precision,
                "recall": tag_perf.recall,
                "average_precision": getattr(tag_perf, "average_precision", None),
            })
        results["per_tag"] = per_tag
        results["overall_status"] = "PASS" if all_pass else "NEEDS_IMPROVEMENT"

        logger.info("Evaluation: %s", json.dumps(results, indent=2))
        return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Custom Vision model setup for casino floor analytics.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Create a crowd density detection project
  python custom_vision_setup.py create-project --model-type crowd-density

  # Upload training images
  python custom_vision_setup.py upload-images --project-id $ID --image-dir ./training-data/crowd

  # Train the model
  python custom_vision_setup.py train --project-id $ID --training-type Advanced

  # Export for edge deployment
  python custom_vision_setup.py export --project-id $ID --iteration-id $ITER --platform ONNX

  # Evaluate against targets
  python custom_vision_setup.py evaluate --project-id $ID --iteration-id $ITER --model-type crowd-density
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # create-project
    create_parser = subparsers.add_parser("create-project", help="Create Custom Vision project")
    create_parser.add_argument(
        "--model-type",
        choices=list(MODEL_CONFIGS.keys()),
        required=True,
        help="Model type to create",
    )

    # upload-images
    upload_parser = subparsers.add_parser("upload-images", help="Upload training images")
    upload_parser.add_argument("--project-id", required=True, help="Project ID")
    upload_parser.add_argument("--image-dir", required=True, help="Training data directory")
    upload_parser.add_argument("--batch-size", type=int, default=64, help="Batch size")

    # train
    train_parser = subparsers.add_parser("train", help="Train model")
    train_parser.add_argument("--project-id", required=True, help="Project ID")
    train_parser.add_argument(
        "--training-type",
        choices=["Regular", "Advanced"],
        default="Regular",
        help="Training type",
    )
    train_parser.add_argument("--budget-hours", type=int, default=1, help="Max hours for Advanced")

    # export
    export_parser = subparsers.add_parser("export", help="Export trained model")
    export_parser.add_argument("--project-id", required=True, help="Project ID")
    export_parser.add_argument("--iteration-id", required=True, help="Iteration ID")
    export_parser.add_argument(
        "--platform",
        choices=["ONNX", "DockerFile", "TensorFlow"],
        default="ONNX",
        help="Export platform",
    )

    # evaluate
    eval_parser = subparsers.add_parser("evaluate", help="Evaluate model performance")
    eval_parser.add_argument("--project-id", required=True, help="Project ID")
    eval_parser.add_argument("--iteration-id", required=True, help="Iteration ID")
    eval_parser.add_argument(
        "--model-type",
        choices=list(MODEL_CONFIGS.keys()),
        default="crowd-density",
        help="Model type for target metrics",
    )

    # Global args
    parser.add_argument(
        "--training-key",
        default=os.environ.get("CUSTOM_VISION_TRAINING_KEY", ""),
        help="Training key",
    )
    parser.add_argument(
        "--training-endpoint",
        default=os.environ.get("CUSTOM_VISION_TRAINING_ENDPOINT", ""),
        help="Training endpoint",
    )
    parser.add_argument(
        "--prediction-key",
        default=os.environ.get("CUSTOM_VISION_PREDICTION_KEY", ""),
        help="Prediction key",
    )
    parser.add_argument(
        "--prediction-endpoint",
        default=os.environ.get("CUSTOM_VISION_PREDICTION_ENDPOINT", ""),
        help="Prediction endpoint",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.getLogger().setLevel(getattr(logging, args.log_level))

    if not args.command:
        logger.error("No command specified. Use --help for available commands.")
        return 1

    if not args.training_key or not args.training_endpoint:
        logger.error(
            "Training key and endpoint required.\n"
            "Set CUSTOM_VISION_TRAINING_KEY and CUSTOM_VISION_TRAINING_ENDPOINT\n"
            "or use --training-key and --training-endpoint flags."
        )
        return 1

    manager = CustomVisionManager(
        training_key=args.training_key,
        training_endpoint=args.training_endpoint,
        prediction_key=args.prediction_key,
        prediction_endpoint=args.prediction_endpoint,
    )
    manager.connect()

    if args.command == "create-project":
        result = manager.create_project(args.model_type)
        print(json.dumps(result, indent=2))

    elif args.command == "upload-images":
        result = manager.upload_images(
            args.project_id,
            args.image_dir,
            batch_size=args.batch_size,
        )
        print(json.dumps(result, indent=2))

    elif args.command == "train":
        result = manager.train(
            args.project_id,
            training_type=args.training_type,
            reserved_budget_hours=args.budget_hours,
        )
        print(json.dumps(result, indent=2, default=str))

    elif args.command == "export":
        result = manager.export_model(
            args.project_id,
            args.iteration_id,
            platform=args.platform,
        )
        print(json.dumps(result, indent=2))

    elif args.command == "evaluate":
        result = manager.evaluate(
            args.project_id,
            args.iteration_id,
            model_type=args.model_type,
        )
        print(json.dumps(result, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
