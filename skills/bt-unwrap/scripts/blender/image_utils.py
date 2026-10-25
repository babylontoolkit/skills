"""
Image helpers for bt-unwrap: read and write images as numpy arrays through Blender, sample them, and
grow island colors into the padding around them.

Every array here is float32 RGBA in Blender's pixel order: row 0 is the BOTTOM of the image, so a texture
coordinate (u, v) maps to pixel (u * width, v * height) with no flip.
"""
import os

import bpy
import numpy as np

# Blender file formats by output extension.
FILE_FORMAT_BY_EXTENSION = {
    ".png": "PNG",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".webp": "WEBP",
    ".tga": "TARGA",
    ".tif": "TIFF",
    ".tiff": "TIFF",
}

# 8-neighbourhood offsets used by the padding dilation, as (row, column) shifts.
NEIGHBOUR_OFFSETS = ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1))


def load_image_array(path: str) -> np.ndarray:
    """
    Loads an image file as raw stored values, with no color management applied.

    :param path: Any image format Blender reads (PNG, JPEG, WebP, TGA, EXR, ...).
    :returns: float32 array of shape (height, width, 4), row 0 at the bottom of the image.
    :raises RuntimeError: when the file cannot be read as an image.
    """
    try:
        image = bpy.data.images.load(path, check_existing=False)
    except RuntimeError as error:
        raise RuntimeError(f"cannot read image '{path}': {error}") from error
    image.colorspace_settings.name = "Non-Color"
    width, height = image.size
    if width == 0 or height == 0:
        bpy.data.images.remove(image)
        raise RuntimeError(f"image '{path}' is empty")
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(height, width, 4)


def read_blender_image(image: bpy.types.Image) -> np.ndarray:
    """
    Copies an image datablock that is already in memory (for example a fresh bake target) into numpy.

    :param image: The Blender image to read.
    :returns: float32 array of shape (height, width, 4), row 0 at the bottom.
    """
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    return pixels.reshape(height, width, 4)


def save_image_array(array: np.ndarray, path: str, quality: int = 92) -> str:
    """
    Writes an RGB or RGBA array to disk as an 8-bit image. Values are stored as they are, so pass sRGB
    values for color maps and raw data for normal / metallic-roughness maps.

    :param array: float array (height, width, 3 or 4) in the 0..1 range, row 0 at the bottom.
    :param path: Output path; the extension picks the format (png, jpg, webp, tga, tif).
    :param quality: JPEG / WebP quality, 0..100.
    :returns: The path written.
    :raises ValueError: when the extension is not a supported image format.
    """
    extension = os.path.splitext(path)[1].lower()
    file_format = FILE_FORMAT_BY_EXTENSION.get(extension)
    if file_format is None:
        raise ValueError(f"unsupported image extension '{extension}' for '{path}'")
    height, width = array.shape[:2]
    rgba = np.ones((height, width, 4), dtype=np.float32)
    rgba[:, :, : min(4, array.shape[2])] = np.clip(array[:, :, :4], 0.0, 1.0)
    image = bpy.data.images.new(os.path.basename(path), width, height, alpha=True, float_buffer=False)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(rgba.ravel())
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    image.filepath_raw = path
    image.file_format = file_format
    image.save(quality=quality)
    bpy.data.images.remove(image)
    return path


def sample_bilinear(image: np.ndarray, pixel_x: np.ndarray, pixel_y: np.ndarray) -> np.ndarray:
    """
    Bilinearly samples an image at continuous pixel coordinates, clamping at the borders.

    :param image: Array of shape (height, width, channels).
    :param pixel_x: Horizontal coordinates in pixels; pixel centers sit at i + 0.5.
    :param pixel_y: Vertical coordinates in pixels, measured from the bottom row.
    :returns: Array of shape (count, channels).
    """
    height, width = image.shape[:2]
    x = np.clip(pixel_x - 0.5, 0.0, width - 1.0)
    y = np.clip(pixel_y - 0.5, 0.0, height - 1.0)
    left = np.floor(x).astype(np.int32)
    bottom = np.floor(y).astype(np.int32)
    right = np.minimum(left + 1, width - 1)
    top = np.minimum(bottom + 1, height - 1)
    blend_x = (x - left)[:, None]
    blend_y = (y - bottom)[:, None]
    lower_row = image[bottom, left] * (1.0 - blend_x) + image[bottom, right] * blend_x
    upper_row = image[top, left] * (1.0 - blend_x) + image[top, right] * blend_x
    return lower_row * (1.0 - blend_y) + upper_row * blend_y


def sample_nearest(image: np.ndarray, pixel_x: np.ndarray, pixel_y: np.ndarray) -> np.ndarray:
    """
    Samples the nearest pixel at continuous pixel coordinates, clamping at the borders.

    :param image: Array of shape (height, width) or (height, width, channels).
    :param pixel_x: Horizontal coordinates in pixels.
    :param pixel_y: Vertical coordinates in pixels, measured from the bottom row.
    :returns: The sampled values, one per coordinate.
    """
    height, width = image.shape[:2]
    column = np.clip(np.floor(pixel_x).astype(np.int64), 0, width - 1)
    row = np.clip(np.floor(pixel_y).astype(np.int64), 0, height - 1)
    return image[row, column]


def resize_image(image: np.ndarray, new_width: int, new_height: int) -> np.ndarray:
    """
    Resizes an image. Shrinking by a whole factor averages pixel blocks so thin details survive; any
    remaining change is bilinear.

    :param image: Array of shape (height, width, channels) or (height, width).
    :param new_width: Target width in pixels.
    :param new_height: Target height in pixels.
    :returns: The resized array, same channel layout and dtype float32.
    """
    is_single_channel = image.ndim == 2
    working = image[:, :, None] if is_single_channel else image
    working = working.astype(np.float32, copy=False)
    height, width = working.shape[:2]
    block_factor = min(width // max(new_width, 1), height // max(new_height, 1))
    if block_factor >= 2:
        trimmed_height = (height // block_factor) * block_factor
        trimmed_width = (width // block_factor) * block_factor
        working = working[:trimmed_height, :trimmed_width]
        working = working.reshape(
            trimmed_height // block_factor, block_factor, trimmed_width // block_factor, block_factor, -1
        ).mean(axis=(1, 3))
    height, width = working.shape[:2]
    if (width, height) != (new_width, new_height):
        grid_x, grid_y = np.meshgrid(
            (np.arange(new_width) + 0.5) * width / new_width,
            (np.arange(new_height) + 0.5) * height / new_height,
        )
        working = sample_bilinear(working, grid_x.ravel(), grid_y.ravel()).reshape(new_height, new_width, -1)
    return working[:, :, 0] if is_single_channel else working


def downsample_map(image: np.ndarray, size: int, is_normal_map: bool = False) -> np.ndarray:
    """
    Filters a square texture down to its output size (block averaging, so thin lines and text stay clean).
    Normal maps are averaged as vectors and re-normalised.

    :param image: float32 (height, width, channels) or (height, width), values 0..1.
    :param size: Output side length in pixels; the input is returned unchanged when already this size.
    :param is_normal_map: Treat RGB as an encoded tangent-space normal.
    :returns: float32 array (size, size[, channels]).
    """
    if image.shape[0] == size and image.shape[1] == size:
        return image
    resized = resize_image(image, size, size)
    if is_normal_map:
        vectors = resized[:, :, :3] * 2.0 - 1.0
        vectors /= np.maximum(np.linalg.norm(vectors, axis=2, keepdims=True), 1e-6)
        resized[:, :, :3] = vectors * 0.5 + 0.5
    return resized


def erode_mask(mask: np.ndarray, iterations: int) -> np.ndarray:
    """
    Shrinks a boolean mask by a number of pixels (4-neighbourhood).

    :param mask: Boolean array (height, width).
    :param iterations: How many pixels to remove from every edge.
    :returns: The eroded mask.
    """
    eroded = mask.copy()
    for _ in range(max(0, iterations)):
        shrunk = eroded.copy()
        shrunk[1:, :] &= eroded[:-1, :]
        shrunk[:-1, :] &= eroded[1:, :]
        shrunk[:, 1:] &= eroded[:, :-1]
        shrunk[:, :-1] &= eroded[:, 1:]
        eroded = shrunk
    return eroded


def dilate_mask(mask: np.ndarray, iterations: int) -> np.ndarray:
    """
    Grows a boolean mask by a number of pixels (4-neighbourhood).

    :param mask: Boolean array (height, width).
    :param iterations: How many pixels to add around every edge.
    :returns: The dilated mask.
    """
    return ~erode_mask(~mask, iterations)


def dilate_colors(colors: np.ndarray, covered: np.ndarray, iterations: int) -> np.ndarray:
    """
    Pads texture islands: every uncovered pixel next to covered ones takes the average of its covered
    neighbours, repeated outward. This stops mipmapping and bilinear filtering from pulling background
    color into the edges of UV islands.

    :param colors: float32 array (height, width, channels); modified copy is returned.
    :param covered: Boolean array (height, width) of pixels that hold real surface color.
    :param iterations: Padding width in pixels.
    :returns: The padded color array.
    """
    padded = colors.copy()
    filled = covered.copy()
    height, width = filled.shape
    for _ in range(max(0, iterations)):
        color_sum = np.zeros_like(padded)
        neighbour_count = np.zeros((height, width), dtype=np.float32)
        for row_shift, column_shift in NEIGHBOUR_OFFSETS:
            source_rows = slice(max(0, -row_shift), height - max(0, row_shift))
            target_rows = slice(max(0, row_shift), height - max(0, -row_shift))
            source_columns = slice(max(0, -column_shift), width - max(0, column_shift))
            target_columns = slice(max(0, column_shift), width - max(0, -column_shift))
            neighbour_filled = filled[source_rows, source_columns]
            color_sum[target_rows, target_columns] += padded[source_rows, source_columns] * neighbour_filled[:, :, None]
            neighbour_count[target_rows, target_columns] += neighbour_filled
        frontier = (~filled) & (neighbour_count > 0)
        if not frontier.any():
            break
        padded[frontier] = color_sum[frontier] / neighbour_count[frontier][:, None]
        filled |= frontier
    return padded


def srgb_to_linear(values: np.ndarray) -> np.ndarray:
    """
    Converts sRGB-encoded values to linear light.

    :param values: Array of sRGB values in 0..1.
    :returns: Linear values in 0..1.
    """
    return np.where(values <= 0.04045, values / 12.92, ((values + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(values: np.ndarray) -> np.ndarray:
    """
    Converts linear-light values to sRGB encoding.

    :param values: Array of linear values in 0..1.
    :returns: sRGB values in 0..1.
    """
    clipped = np.clip(values, 0.0, 1.0)
    return np.where(clipped <= 0.0031308, clipped * 12.92, 1.055 * np.power(clipped, 1.0 / 2.4) - 0.055)
