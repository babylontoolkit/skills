"""
Visual proof for bt-unwrap: before / after renders from fixed views, a side-by-side comparison sheet,
UV island maps (the island map is the uv-layout input bt-atlas expects), and reference alignment overlays.

Renders use Workbench with flat lighting and texture color only, so what you see is the texture itself —
no lighting can hide a smeared or stretched texture.
"""
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

import image_utils
import mesh_tools
import uv_layout

PREVIEW_VIEWS = {
    "front": (0.0, -1.0, 0.0),
    "left": (1.0, 0.0, 0.0),
    "rear": (0.0, 1.0, 0.0),
    "right": (-1.0, 0.0, 0.0),
    "top": (0.0, 0.0, 1.0),
    "three_quarter_front": (0.8, -1.0, 0.6),
    "three_quarter_rear": (-0.8, 1.0, 0.6),
}
FRAME_MARGIN = 1.08
BACKDROP_COLOR = (0.82, 0.82, 0.82)
OUTLINE_COLOR = np.array((1.0, 0.1, 0.1, 1.0), dtype=np.float32)
SHEET_GAP_PIXELS = 8
LAYOUT_PREVIEW_MAX = 2048
OVERLAY_MAX = 1400


def render_with_texture(objects: list, texture_path: str, output_dir: str, prefix: str, resolution: int) -> dict:
    """
    Renders the objects with a different base color texture on the same UV layout (e.g. the reference
    coverage map), restoring the real texture afterwards.

    :param objects: Mesh objects whose material shows its base color through the active image node.
    :param texture_path: Image to show instead.
    :param output_dir: Folder for the PNG files.
    :param prefix: File name prefix.
    :param resolution: Square image size in pixels.
    :returns: view name -> written file path.
    """
    replacement = bpy.data.images.load(texture_path, check_existing=False)
    swapped = []
    for obj in mesh_tools.mesh_objects(objects):
        for slot in obj.material_slots:
            material = slot.material
            node = material.node_tree.nodes.active if material and material.use_nodes else None
            if node is not None and node.type == "TEX_IMAGE":
                swapped.append((node, node.image))
                node.image = replacement
    try:
        return render_views(objects, output_dir, prefix, resolution)
    finally:
        for node, original in swapped:
            node.image = original
        bpy.data.images.remove(replacement)


def render_views(objects: list, output_dir: str, prefix: str, resolution: int) -> dict:
    """
    Renders the given objects (everything else hidden) from every preview view.

    :param objects: Objects to show.
    :param output_dir: Folder for the PNG files.
    :param prefix: File name prefix, e.g. 'before' or 'after'.
    :param resolution: Square image size in pixels.
    :returns: view name -> written file path.
    """
    scene = bpy.context.scene
    visible = set(objects)
    hidden_state = {}
    for obj in scene.objects:
        hidden_state[obj.name] = obj.hide_render
        obj.hide_render = obj not in visible

    previous_engine = scene.render.engine
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    world = scene.world or bpy.data.worlds.new("PreviewBackdrop")
    world.color = BACKDROP_COLOR
    scene.world = world

    camera_data = bpy.data.cameras.new("BtUnwrapPreviewCamera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("BtUnwrapPreviewCamera", camera_data)
    scene.collection.objects.link(camera)
    previous_camera = scene.camera
    scene.camera = camera

    positions = mesh_tools.world_vertex_positions(mesh_tools.mesh_objects(objects))
    center = (positions.min(axis=0) + positions.max(axis=0)) / 2.0
    radius = float(np.linalg.norm(positions.max(axis=0) - positions.min(axis=0)))
    written = {}
    os.makedirs(output_dir, exist_ok=True)
    for view_name, raw_direction in PREVIEW_VIEWS.items():
        direction = np.array(raw_direction) / np.linalg.norm(raw_direction)
        right, up = uv_layout.view_axes(direction)
        relative = positions - center
        extent_across = np.ptp(relative @ right)
        extent_up = np.ptp(relative @ up)
        camera_data.ortho_scale = max(extent_across, extent_up) * FRAME_MARGIN
        camera_data.clip_start = radius * 0.01
        camera_data.clip_end = radius * 4.0
        offset_center = center + right * ((relative @ right).max() + (relative @ right).min()) / 2.0 + \
            up * ((relative @ up).max() + (relative @ up).min()) / 2.0
        camera.matrix_world = Matrix.Translation(Vector(offset_center + direction * radius * 2.0)) @ \
            Matrix((right.tolist(), up.tolist(), direction.tolist())).transposed().to_4x4()
        scene.render.filepath = os.path.join(output_dir, f"{prefix}_{view_name}.png")
        bpy.ops.render.render(write_still=True)
        written[view_name] = scene.render.filepath

    scene.camera = previous_camera
    bpy.data.objects.remove(camera, do_unlink=True)
    bpy.data.cameras.remove(camera_data)
    scene.render.engine = previous_engine
    for obj in scene.objects:
        if obj.name in hidden_state:
            obj.hide_render = hidden_state[obj.name]
    return written


def comparison_sheet(before: dict, after: dict, output_path: str) -> str:
    """
    Stacks before (left column) and after (right column) renders, one row per view, top to bottom in the
    order of PREVIEW_VIEWS.

    :param before: view -> file path of the 'before' renders.
    :param after: view -> file path of the 'after' renders.
    :param output_path: PNG file to write.
    :returns: The path written.
    """
    rows = []
    for view_name in PREVIEW_VIEWS:
        if view_name not in before or view_name not in after:
            continue
        left = image_utils.load_image_array(before[view_name])
        right = image_utils.load_image_array(after[view_name])
        gap = np.ones((left.shape[0], SHEET_GAP_PIXELS, 4), dtype=np.float32)
        rows.append(np.concatenate((left, gap, right), axis=1))
    if not rows:
        return ""
    row_gap = np.ones((SHEET_GAP_PIXELS, rows[0].shape[1], 4), dtype=np.float32)
    stacked = []
    for row in reversed(rows):  # arrays are bottom-up, so the first view goes last
        stacked.extend((row, row_gap))
    return image_utils.save_image_array(np.concatenate(stacked[:-1], axis=0), output_path)


def uv_layout_images(color: np.ndarray, covered: np.ndarray, output_dir: str, stem: str) -> dict:
    """
    Writes the island map (white islands on black — bt-atlas's uv-layout input) and an outline overlay on
    the final base color for people to read.

    :param color: float32 (size, size, 4) final base color.
    :param covered: Boolean (size, size) texels on the model.
    :param output_dir: Folder to write into.
    :param stem: File name stem.
    :returns: {'islands': path, 'overlay': path}.
    """
    size = covered.shape[0]
    preview_size = min(size, LAYOUT_PREVIEW_MAX)
    islands = np.repeat(covered[:, :, None].astype(np.float32), 3, axis=2)
    islands_path = image_utils.save_image_array(
        image_utils.resize_image(islands, preview_size, preview_size) if preview_size != size else islands,
        os.path.join(output_dir, f"{stem}_uv_islands.png"))
    outline = covered & ~image_utils.erode_mask(covered, max(1, size // 1024))
    overlay = color.copy()
    overlay[outline] = OUTLINE_COLOR
    if preview_size != size:
        overlay = image_utils.resize_image(overlay, preview_size, preview_size)
    overlay_path = image_utils.save_image_array(overlay, os.path.join(output_dir, f"{stem}_uv_layout.png"))
    return {"islands": islands_path, "overlay": overlay_path}


def alignment_overlay(reference, output_dir: str) -> str:
    """
    Draws the fitted mesh silhouette in red over a reference image, to check the alignment by eye.

    :param reference: An aligned reference with a depth buffer.
    :param output_dir: Folder to write into.
    :returns: The path written.
    """
    image = reference.pixels.copy()
    covered = np.isfinite(reference.depth)
    thickness = max(1, image.shape[1] // 700)
    outline = covered & ~image_utils.erode_mask(covered, thickness)
    image[covered & ~outline, :3] = image[covered & ~outline, :3] * 0.85 + np.array((0.15, 0.0, 0.0))
    image[outline] = OUTLINE_COLOR
    height, width = image.shape[:2]
    scale = min(1.0, OVERLAY_MAX / max(width, height))
    if scale < 1.0:
        image = image_utils.resize_image(image, int(width * scale), int(height * scale))
    return image_utils.save_image_array(image, os.path.join(output_dir, f"align_{reference.view}.png"))
