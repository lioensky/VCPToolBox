from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from PIL import Image, ImageOps


DEFAULT_TARGET_DIR = Path("image") / "Nova表情包"
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def format_bytes(size: int) -> str:
    units = ("B", "KB", "MB", "GB")
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.2f} {unit}" if unit != "B" else f"{int(value)} {unit}"
        value /= 1024
    return f"{size} B"


def get_output_kwargs(path: Path, image: Image.Image) -> dict:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return {
            "format": "JPEG",
            "quality": 88,
            "optimize": True,
            "progressive": True,
        }

    if suffix == ".png":
        kwargs = {
            "format": "PNG",
            "optimize": True,
        }
        if image.mode == "P":
            kwargs["bits"] = 8
        return kwargs

    return {}


def prepare_image_for_save(path: Path, image: Image.Image) -> Image.Image:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"} and image.mode in {"RGBA", "LA", "P"}:
        background = Image.new("RGB", image.size, (255, 255, 255))
        if image.mode == "P":
            image = image.convert("RGBA")
        alpha = image.getchannel("A") if image.mode in {"RGBA", "LA"} else None
        background.paste(image.convert("RGB"), mask=alpha)
        return background

    return image


def compress_one(path: Path, max_side: int, backup: bool, dry_run: bool) -> tuple[str, str]:
    original_size = path.stat().st_size

    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened)
        width, height = image.size
        largest_side = max(width, height)

        if largest_side <= max_side:
            return "skip", f"{path.name}: {width}x{height} 已低于或等于 {max_side}，跳过"

        ratio = max_side / largest_side
        new_size = (max(1, round(width * ratio)), max(1, round(height * ratio)))

        if dry_run:
            return "dry-run", f"{path.name}: {width}x{height} -> {new_size[0]}x{new_size[1]}"

        if backup:
            backup_path = path.with_suffix(path.suffix + ".bak")
            if not backup_path.exists():
                shutil.copy2(path, backup_path)

        resized = image.resize(new_size, Image.Resampling.LANCZOS)
        resized = prepare_image_for_save(path, resized)

        save_kwargs = get_output_kwargs(path, resized)
        resized.save(path, **save_kwargs)

    new_file_size = path.stat().st_size
    saved = original_size - new_file_size
    return (
        "done",
        (
            f"{path.name}: {width}x{height} -> {new_size[0]}x{new_size[1]}, "
            f"{format_bytes(original_size)} -> {format_bytes(new_file_size)}, "
            f"节省 {format_bytes(saved)}"
        ),
    )


def iter_images(target_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in target_dir.iterdir()
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="等比例压缩 image/Nova表情包 下超过指定边长的 jpg/jpeg/png 图片。"
    )
    parser.add_argument(
        "--dir",
        type=Path,
        default=DEFAULT_TARGET_DIR,
        help=f"目标图片目录，默认：{DEFAULT_TARGET_DIR}",
    )
    parser.add_argument(
        "--max-side",
        type=int,
        default=512,
        help="最大边长，默认：512",
    )
    parser.add_argument(
        "--backup",
        action="store_true",
        help="压缩前为原图创建 .bak 备份文件。",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只预览会处理哪些图片，不写入文件。",
    )
    args = parser.parse_args()

    target_dir = args.dir
    if not target_dir.exists() or not target_dir.is_dir():
        print(f"目标目录不存在或不是目录：{target_dir}")
        return 1

    if args.max_side <= 0:
        print("--max-side 必须大于 0")
        return 1

    images = iter_images(target_dir)
    if not images:
        print(f"未找到 jpg/jpeg/png 图片：{target_dir}")
        return 0

    counts = {"done": 0, "skip": 0, "dry-run": 0, "error": 0}

    for image_path in images:
        try:
            status, message = compress_one(
                image_path,
                max_side=args.max_side,
                backup=args.backup,
                dry_run=args.dry_run,
            )
            counts[status] += 1
            print(message)
        except Exception as exc:
            counts["error"] += 1
            print(f"{image_path.name}: 处理失败：{exc}")

    print(
        "完成："
        f"处理 {counts['done']}，"
        f"跳过 {counts['skip']}，"
        f"预览 {counts['dry-run']}，"
        f"失败 {counts['error']}"
    )

    return 1 if counts["error"] else 0


if __name__ == "__main__":
    raise SystemExit(main())