"""
New UV layouts for bt-unwrap.

The default 'views' method lays every face out flat as seen from the camera direction it faces most:
front, rear, left, right, top or bottom (optionally diagonals too). Faces that share a direction form large
islands, seams fall where the facing direction changes, and every island is an undistorted orthographic
picture of its surface — text stays upright and is never mirrored, and reference images taken from the same
directions line up with it directly.

The model must already face Blender -Y with +Z up (the pipeline orients it first): front = -Y, rear = +Y,
left = +X, right = -X, top = +Z, bottom = -Z.
"""
import math
from contextlib import contextmanager

import bpy
import numpy as np

import mesh_tools
import rasterizer

NEW_UV_LAYER = "UVMap_bt"
FINAL_UV_LAYER = "UVMap"

# Outward direction of every named view in the oriented model frame.
VIEW_DIRECTIONS = {
    "front": (0.0, -1.0, 0.0),
    "rear": (0.0, 1.0, 0.0),
    "left": (1.0, 0.0, 0.0),
    "right": (-1.0, 0.0, 0.0),
    "top": (0.0, 0.0, 1.0),
    "bottom": (0.0, 0.0, -1.0),
}
HORIZONTAL_DIAGONALS = {
    "front_left": (1.0, -1.0, 0.0),
    "front_right": (-1.0, -1.0, 0.0),
    "rear_left": (1.0, 1.0, 0.0),
    "rear_right": (-1.0, 1.0, 0.0),
}
CORNER_DIAGONALS = {
    "top_front_left": (1.0, -1.0, 1.0), "top_front_right": (-1.0, -1.0, 1.0),
    "top_rear_left": (1.0, 1.0, 1.0), "top_rear_right": (-1.0, 1.0, 1.0),
    "bottom_front_left": (1.0, -1.0, -1.0), "bottom_front_right": (-1.0, -1.0, -1.0),
    "bottom_rear_left": (1.0, 1.0, -1.0), "bottom_rear_right": (-1.0, 1.0, -1.0),
}
FORWARD = np.array((0.0, -1.0, 0.0))
UP = np.array((0.0, 0.0, 1.0))

# A neighbour's vote counts this much less than the face's own label, so labels settle instead of flickering.
SELF_VOTE_WEIGHT = 1.5
SMALL_ISLAND_PASSES = 16
# Tiny islands may join any neighbouring view the face does not point away from (about 87 degrees): on
# small parts a little stretch costs far less than a scatter of fragments.
SMALL_ISLAND_MINIMUM_FACING = 0.05
OVERLAP_CHECK_RESOLUTION = 1024
SELF_OVERLAP_RESOLUTION = 256     # smallest fold-check raster per island, within its own bounds
MAXIMUM_FOLD_CHECK_RESOLUTION = 1024
FOLD_CHECK_TEXTURE_SIZE = 2400    # an island covering the whole surface is checked at about this size
MINIMUM_FOLD_TRIANGLES = 3        # one or two triangles cannot fold over themselves in a meaningful way
FOLD_GRAZING_FACING = (0.4, 0.6, 0.6)   # per pass: folded faces facing their view less than this are moved
FOLD_SPLIT_PASSES = len(FOLD_GRAZING_FACING)
PACK_ROTATION = {"none": (False, "ANY"), "cardinal": (True, "CARDINAL"), "any": (True, "ANY")}
# Texel density by visibility: every face is tested from the 26 directions around a cube (sides, edges and
# corners). Islands seen from none of them (inside the body, under covers) shrink to --hidden-density.
VISIBILITY_RASTER_SIZE = 640           # depth raster per direction for dense meshes...
VISIBILITY_RASTER_PER_TRIANGLE_ROOT = 4  # ...smaller for low-poly ones, whose big faces need no fine raster
VISIBILITY_MINIMUM_RASTER = 96
VISIBILITY_FACING = 0.1               # a face must turn at least this much toward a direction to be seen from it
VISIBILITY_DEPTH_TOLERANCE = 0.004    # of the model diagonal
VISIBILITY_FULL_DIRECTIONS = 2        # seen from this many directions counts as fully visible


def projection_directions(projection_count: int) -> dict:
    """
    Chooses the set of view directions faces are sorted into.

    :param projection_count: 6 (box), 10 (box + horizontal diagonals) or 14 (box + corners).
    :returns: Ordered dict of view name -> unit direction (numpy 3-vector).
    """
    directions = dict(VIEW_DIRECTIONS)
    if projection_count == 10:
        directions.update(HORIZONTAL_DIAGONALS)
    elif projection_count == 14:
        directions.update(CORNER_DIAGONALS)
    return {name: np.array(vector) / np.linalg.norm(vector) for name, vector in directions.items()}


def view_axes(direction: np.ndarray) -> tuple:
    """
    Image axes of an orthographic camera that sits on the given side of the model and looks back at it.
    Side views keep +Z up; the top and bottom views put the model's front at the top of the image.

    :param direction: Unit vector from the model toward the camera.
    :returns: (right, up) unit vectors in world space.
    """
    view_direction = -direction
    up_hint = UP if abs(direction[2]) < 0.9 else FORWARD
    right = np.cross(view_direction, up_hint)
    right /= np.linalg.norm(right)
    up = np.cross(right, view_direction)
    return right, up / np.linalg.norm(up)


@contextmanager
def edit_mode(objects: list):
    """
    Puts the given mesh objects into edit mode together and returns them to object mode afterwards.

    :param objects: Mesh objects to edit.
    """
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        yield
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")


def ensure_new_uv_layer(obj: bpy.types.Object) -> bpy.types.MeshUVLoopLayer:
    """
    Adds (or reuses) the working UV layer and makes it the active and render layer.

    :param obj: A mesh object.
    :returns: The working UV layer.
    """
    layers = obj.data.uv_layers
    layer = layers.get(NEW_UV_LAYER) or layers.new(name=NEW_UV_LAYER)
    layers.active = layer
    layer.active_render = True
    return layer


def unwrap_by_views(objects: list, options) -> dict:
    """
    Lays every face out from the view direction it faces most, then repairs overlaps and packs.

    :param objects: Mesh objects of the oriented model.
    :param options: Parsed command-line options (projections, label_smoothing, min_island_faces,
        max_facing_angle, view_density, padding, texture_size, pack_rotate, fix_overlaps).
    :returns: Statistics: island count per view, faces per view, overlap repairs and packing efficiency.
    """
    directions = projection_directions(options.projections)
    names = list(directions)
    direction_matrix = np.stack([directions[name] for name in names])
    axes = [view_axes(directions[name]) for name in names]
    density = np.array([options.view_density.get(name, 1.0) for name in names])
    minimum_facing = math.cos(math.radians(options.max_facing_angle))

    meshes = mesh_tools.mesh_objects(objects)
    labels_per_object = []
    for obj in meshes:
        labels = _label_faces(obj, direction_matrix, minimum_facing, options)
        _write_projected_uvs(obj, labels, axes)
        labels_per_object.append(labels)

    fold_repair = {"passes": 0, "faces_moved": 0}
    if options.fix_overlaps:
        fold_repair = _split_folds(meshes, labels_per_object, direction_matrix, axes)
    faces_per_view = sum(np.bincount(labels, minlength=len(names)) for labels in labels_per_object)
    _average_island_scale(meshes)
    if np.any(density != 1.0):
        for obj, labels in zip(meshes, labels_per_object):
            _scale_islands_by_view(obj, labels, density)
    visibility = scale_islands_by_visibility(meshes, options.hidden_density)
    _pack(meshes, options)
    statistics = layout_statistics(objects)
    statistics.update({
        "method": "views",
        "projections": names,
        "faces_per_view": {name: int(count) for name, count in zip(names, faces_per_view)},
        "fold_repair": fold_repair,
        "visibility": visibility,
    })
    return statistics


def _label_faces(obj, direction_matrix, minimum_facing, options) -> np.ndarray:
    """Sorts one object's faces into view directions, smooths the result and absorbs tiny islands; marks
    seams where the view changes. Returns the view index per polygon."""
    mesh = obj.data
    polygon_count = len(mesh.polygons)
    normals = np.empty(polygon_count * 3, dtype=np.float64)
    mesh.polygons.foreach_get("normal", normals)
    normal_matrix = np.array(obj.matrix_world.to_3x3().inverted_safe().transposed(), dtype=np.float64)
    normals = normals.reshape(-1, 3) @ normal_matrix.T
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-20)
    areas = np.empty(polygon_count, dtype=np.float64)
    mesh.polygons.foreach_get("area", areas)

    facing = normals @ direction_matrix.T
    labels = facing.argmax(axis=1)
    allowed = facing >= minimum_facing
    allowed[np.arange(polygon_count), labels] = True
    allowed_for_small = facing >= SMALL_ISLAND_MINIMUM_FACING
    allowed_for_small[np.arange(polygon_count), labels] = True
    pairs, edge_index = mesh_tools.polygon_adjacency_with_edges(mesh)

    for _ in range(options.label_smoothing):
        votes = np.zeros_like(facing)
        np.add.at(votes, (np.arange(polygon_count), labels), areas * SELF_VOTE_WEIGHT)
        np.add.at(votes, (pairs[:, 0], labels[pairs[:, 1]]), areas[pairs[:, 1]])
        np.add.at(votes, (pairs[:, 1], labels[pairs[:, 0]]), areas[pairs[:, 0]])
        votes[~allowed] = -1.0
        labels = votes.argmax(axis=1)

    for _ in range(SMALL_ISLAND_PASSES):
        components = _same_label_components(polygon_count, pairs, labels)
        _, inverse, sizes = np.unique(components, return_inverse=True, return_counts=True)
        island_size = sizes[inverse]
        is_small = island_size < options.min_island_faces
        if not is_small.any():
            break
        # A small island is absorbed by its neighbours, the bigger the neighbouring island the stronger its
        # pull; only strictly bigger islands may absorb, so two small islands never trade faces back and forth.
        votes = np.zeros_like(facing)
        for receiver, giver in ((pairs[:, 0], pairs[:, 1]), (pairs[:, 1], pairs[:, 0])):
            absorbs = is_small[receiver] & (island_size[giver] > island_size[receiver])
            np.add.at(votes, (receiver[absorbs], labels[giver[absorbs]]),
                      areas[giver[absorbs]] * island_size[giver[absorbs]])
        votes[~allowed_for_small] = 0.0
        has_vote = votes.max(axis=1) > 0
        if not has_vote.any():
            break
        labels[has_vote] = votes[has_vote].argmax(axis=1)

    _mark_seams(mesh, pairs, edge_index, labels)
    return labels


def _same_label_components(polygon_count, pairs, labels) -> np.ndarray:
    """Connected groups of faces that share a view label — the future UV islands."""
    same = labels[pairs[:, 0]] == labels[pairs[:, 1]]
    return mesh_tools.connected_components(polygon_count, pairs[same])


def _mark_seams(mesh, pairs, edge_index, labels) -> None:
    """Marks a UV seam on every edge where the view label changes, and clears all other seams."""
    seams = np.zeros(len(mesh.edges), dtype=bool)
    seams[edge_index[labels[pairs[:, 0]] != labels[pairs[:, 1]]]] = True
    mesh.edges.foreach_set("use_seam", seams)


def _write_projected_uvs(obj, labels, axes) -> None:
    """Writes each corner's UV as its world position seen along its face's view (meters, before packing)."""
    mesh = obj.data
    layer = ensure_new_uv_layer(obj)
    loop_vertex = np.empty(len(mesh.loops), dtype=np.int64)
    mesh.loops.foreach_get("vertex_index", loop_vertex)
    loop_totals = np.empty(len(mesh.polygons), dtype=np.int64)
    mesh.polygons.foreach_get("loop_total", loop_totals)
    loop_label = np.repeat(labels, loop_totals)

    coordinates = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", coordinates)
    world_matrix = np.array(obj.matrix_world, dtype=np.float64)
    world = coordinates.reshape(-1, 3) @ world_matrix[:3, :3].T + world_matrix[:3, 3]
    loop_position = world[loop_vertex]

    right_axes = np.stack([axis[0] for axis in axes])
    up_axes = np.stack([axis[1] for axis in axes])
    corner_uvs = np.stack((
        (loop_position * right_axes[loop_label]).sum(axis=1),
        (loop_position * up_axes[loop_label]).sum(axis=1),
    ), axis=1).astype(np.float32)
    layer.data.foreach_set("uv", corner_uvs.ravel())


def _scale_islands_by_view(obj, labels, density) -> None:
    """
    Enlarges (or shrinks) the islands of chosen views so they get more (or less) of the texture, e.g. the
    side panels that carry a livery. Every island holds one view, so scaling about the origin keeps islands
    whole; packing moves them into place afterwards.
    """
    mesh = obj.data
    layer = mesh.uv_layers[NEW_UV_LAYER]
    loop_totals = np.empty(len(mesh.polygons), dtype=np.int64)
    mesh.polygons.foreach_get("loop_total", loop_totals)
    corner_uvs = np.empty(len(mesh.loops) * 2, dtype=np.float32)
    layer.data.foreach_get("uv", corner_uvs)
    corner_uvs = corner_uvs.reshape(-1, 2) * density[np.repeat(labels, loop_totals)][:, None].astype(np.float32)
    layer.data.foreach_set("uv", corner_uvs.ravel())


def _folded_triangles(triangles, triangle_island) -> np.ndarray:
    """
    Finds triangles that take part in a fold: places where an island's own triangles cover the same UV area
    twice. Each island is checked in its own bounding box, so small islands are checked as finely as large
    ones.

    :param triangles: TriangleSet with the working UV layer.
    :param triangle_island: Island id per triangle.
    :returns: Boolean mask over triangles.
    """
    uvs = triangles.uvs[NEW_UV_LAYER].astype(np.float64)
    edges_one = triangles.positions[:, 1] - triangles.positions[:, 0]
    edges_two = triangles.positions[:, 2] - triangles.positions[:, 0]
    surface_area = 0.5 * np.linalg.norm(np.cross(edges_one, edges_two), axis=1)
    total_area = max(float(surface_area.sum()), 1e-12)
    folded = np.zeros(triangles.count, dtype=bool)
    order = np.argsort(triangle_island, kind="stable")
    _, starts = np.unique(triangle_island[order], return_index=True)
    ends = np.r_[starts[1:], order.size]
    for start, end in zip(starts, ends):
        if end - start < MINIMUM_FOLD_TRIANGLES:
            continue
        members = order[start:end]
        island_uvs = uvs[members]
        flat = island_uvs.reshape(-1, 2)
        minimum = flat.min(axis=0)
        extent = max(float((flat.max(axis=0) - minimum).max()), 1e-12)
        # Check each island about as finely as it will appear in the final texture.
        share = float(surface_area[members].sum()) / total_area
        resolution = int(np.clip(FOLD_CHECK_TEXTURE_SIZE * np.sqrt(share), SELF_OVERLAP_RESOLUTION,
                                 MAXIMUM_FOLD_CHECK_RESOLUTION))
        pixels = (island_uvs - minimum) / extent * resolution
        count, _ = rasterizer.rasterize_coverage_count(pixels, resolution, resolution)
        doubled = count > 1
        if not doubled.any():
            continue
        for fragments in rasterizer.rasterize(pixels, resolution, resolution, edge_tolerance=-1e-3):
            involved = np.unique(fragments.triangle_index[doubled[fragments.pixel_index]])
            folded[members[involved]] = True
    return folded


def _split_folds(meshes, labels_per_object, direction_matrix, axes) -> dict:
    """
    Removes folds by moving the folded faces that face their island's view only at a grazing angle (the part
    of the surface that doubles back) to their next-best view, where they form their own small island
    projected without a fold. Repeats a few passes, since a move can expose a smaller fold.

    :returns: {"passes": passes run, "faces_moved": faces given another view}.
    """
    moved_total = 0
    passes = 0
    for passes in range(1, FOLD_SPLIT_PASSES + 1):
        triangles = mesh_tools.collect_triangles(meshes, (NEW_UV_LAYER,))
        island_per_object = [_same_label_components(len(obj.data.polygons), mesh_tools.polygon_adjacency(obj.data), labels)
                             for obj, labels in zip(meshes, labels_per_object)]
        offsets = np.cumsum([0] + [len(obj.data.polygons) for obj in meshes])[:-1]
        polygon_island = np.concatenate([islands + offset for islands, offset in zip(island_per_object, offsets)])
        triangle_polygon = offsets[triangles.object_index] + triangles.polygon_index
        folded = _folded_triangles(triangles, polygon_island[triangle_polygon])
        if not folded.any():
            break
        moved_this_pass = 0
        for object_number, (obj, labels) in enumerate(zip(meshes, labels_per_object)):
            folded_polygons = np.unique(triangles.polygon_index[folded & (triangles.object_index == object_number)])
            if folded_polygons.size == 0:
                continue
            facing = _polygon_facing(obj, direction_matrix)
            own_facing = facing[folded_polygons, labels[folded_polygons]]
            # Only the part that doubles back moves; the head-on part keeps its island intact. Later passes
            # accept less grazing faces for folds the first pass could not resolve.
            to_move = folded_polygons[own_facing < FOLD_GRAZING_FACING[passes - 1]]
            if to_move.size == 0:
                continue
            alternatives = facing[to_move].copy()
            alternatives[np.arange(to_move.size), labels[to_move]] = -np.inf
            best = alternatives.argmax(axis=1)
            movable = alternatives[np.arange(to_move.size), best] >= SMALL_ISLAND_MINIMUM_FACING
            labels[to_move[movable]] = best[movable]
            moved_this_pass += int(movable.sum())
            pairs, edge_index = mesh_tools.polygon_adjacency_with_edges(obj.data)
            _mark_seams(obj.data, pairs, edge_index, labels)
            _write_projected_uvs(obj, labels, axes)
        moved_total += moved_this_pass
        if moved_this_pass == 0:
            break
    return {"passes": passes, "faces_moved": moved_total}


def _polygon_facing(obj, direction_matrix) -> np.ndarray:
    """How directly every polygon faces every view: (polygon_count, view_count) dot products."""
    normals = np.empty(len(obj.data.polygons) * 3, dtype=np.float64)
    obj.data.polygons.foreach_get("normal", normals)
    normal_matrix = np.array(obj.matrix_world.to_3x3().inverted_safe().transposed(), dtype=np.float64)
    normals = normals.reshape(-1, 3) @ normal_matrix.T
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-20)
    return normals @ direction_matrix.T


def scale_islands_by_visibility(meshes: list, hidden_density: float) -> dict:
    """
    Gives surfaces nobody can see less of the texture: each face is tested from the 26 directions around
    the model, and every UV island is scaled by how visible its faces are, from 1 (seen from at least
    VISIBILITY_FULL_DIRECTIONS directions) down to `hidden_density` (seen from none). Packing then hands the
    freed space to the visible islands, so they get more texels for the same texture size.

    :param meshes: Mesh objects with the working UV layer, islands already at equal texel density.
    :param hidden_density: Texel density of fully hidden surface relative to visible surface (1 = off).
    :returns: Statistics: hidden_surface_percent and the hidden_density used.
    """
    if hidden_density >= 1.0:
        return {"hidden_density": 1.0}
    triangles = mesh_tools.collect_triangles(meshes)
    seen_from = _directions_seeing_each_triangle(triangles)
    edge_one = triangles.positions[:, 1] - triangles.positions[:, 0]
    edge_two = triangles.positions[:, 2] - triangles.positions[:, 0]
    areas = 0.5 * np.linalg.norm(np.cross(edge_one, edge_two), axis=1)
    visible_share = np.clip(seen_from / VISIBILITY_FULL_DIRECTIONS, 0.0, 1.0)
    for object_number, obj in enumerate(meshes):
        mine = triangles.object_index == object_number
        if not mine.any():
            continue
        polygon_count = len(obj.data.polygons)
        polygon_area = np.bincount(triangles.polygon_index[mine], weights=areas[mine], minlength=polygon_count)
        polygon_visible = np.bincount(triangles.polygon_index[mine], weights=areas[mine] * visible_share[mine],
                                      minlength=polygon_count)
        islands = uv_islands(obj)
        island_area = np.bincount(islands, weights=polygon_area)
        island_visible = np.bincount(islands, weights=polygon_visible) / np.maximum(island_area, 1e-20)
        island_scale = hidden_density + (1.0 - hidden_density) * island_visible
        _scale_polygon_uvs(obj, island_scale[islands])
    hidden = float((areas * (seen_from == 0)).sum() / max(areas.sum(), 1e-20))
    return {"hidden_density": hidden_density, "hidden_surface_percent": round(hidden * 100.0, 1)}


def _directions_seeing_each_triangle(triangles) -> np.ndarray:
    """Counts, per triangle, how many of the 26 cube directions see its center unobstructed."""
    directions = [np.array((x, y, z), dtype=np.float64) for x in (-1, 0, 1) for y in (-1, 0, 1) for z in (-1, 0, 1)
                  if (x, y, z) != (0, 0, 0)]
    centers = triangles.positions.mean(axis=1)
    face_normals = triangles.face_normals.astype(np.float64)
    flat = triangles.positions.reshape(-1, 3)
    diagonal = float(np.linalg.norm(flat.max(axis=0) - flat.min(axis=0)))
    tolerance = VISIBILITY_DEPTH_TOLERANCE * diagonal
    raster_size = int(np.clip(VISIBILITY_RASTER_PER_TRIANGLE_ROOT * np.sqrt(triangles.count), VISIBILITY_MINIMUM_RASTER,
                              VISIBILITY_RASTER_SIZE))
    seen_from = np.zeros(triangles.count, dtype=np.int32)
    for direction in directions:
        direction /= np.linalg.norm(direction)
        right, up = view_axes(direction)
        plane = np.stack((flat @ right, flat @ up), axis=1)
        minimum = plane.min(axis=0)
        scale = (raster_size - 2) / max(float((plane.max(axis=0) - minimum).max()), 1e-12)
        pixel_points = ((plane - minimum) * scale + 1.0).reshape(-1, 3, 2)
        depth = rasterizer.rasterize_depth(pixel_points, triangles.positions @ direction, raster_size, raster_size)
        center_pixels = (np.stack((centers @ right, centers @ up), axis=1) - minimum) * scale + 1.0
        nearest = depth[np.clip(center_pixels[:, 1].astype(np.int64), 0, raster_size - 1),
                        np.clip(center_pixels[:, 0].astype(np.int64), 0, raster_size - 1)]
        facing = face_normals @ direction >= VISIBILITY_FACING
        seen_from += (facing & (centers @ direction >= nearest - tolerance)).astype(np.int32)
    return seen_from


def uv_islands(obj) -> np.ndarray:
    """
    Island number of every polygon in the working UV layer: faces joined by edges whose two sides have
    identical UVs.

    :param obj: A mesh object with the working UV layer.
    :returns: int64 array (polygon_count,) of island numbers 0..n-1.
    """
    mesh = obj.data
    corner_uvs = np.empty(len(mesh.loops) * 2, dtype=np.float32)
    mesh.uv_layers[NEW_UV_LAYER].data.foreach_get("uv", corner_uvs)
    corner_uvs = corner_uvs.reshape(-1, 2)
    loop_vertex = np.empty(len(mesh.loops), dtype=np.int64)
    mesh.loops.foreach_get("vertex_index", loop_vertex)
    loop_totals = np.empty(len(mesh.polygons), dtype=np.int64)
    mesh.polygons.foreach_get("loop_total", loop_totals)
    polygon_of_loop = np.repeat(np.arange(len(mesh.polygons)), loop_totals)
    # Two faces are UV-connected when they share a vertex at exactly the same UV coordinate.
    quantized = np.round(corner_uvs * 1e6).astype(np.int64)
    keys = np.stack((loop_vertex, quantized[:, 0], quantized[:, 1]), axis=1)
    _, key_id = np.unique(keys, axis=0, return_inverse=True)
    key_id = key_id.ravel()
    order = np.argsort(key_id, kind="stable")
    same = key_id[order][1:] == key_id[order][:-1]
    pairs = np.stack((polygon_of_loop[order][:-1][same], polygon_of_loop[order][1:][same]), axis=1)
    components = mesh_tools.connected_components(len(mesh.polygons), pairs)
    return np.unique(components, return_inverse=True)[1].ravel()


def _scale_polygon_uvs(obj, polygon_scale: np.ndarray) -> None:
    """Scales every polygon's UVs about the origin by its factor (whole islands share one factor)."""
    mesh = obj.data
    layer = mesh.uv_layers[NEW_UV_LAYER]
    loop_totals = np.empty(len(mesh.polygons), dtype=np.int64)
    mesh.polygons.foreach_get("loop_total", loop_totals)
    corner_uvs = np.empty(len(mesh.loops) * 2, dtype=np.float32)
    layer.data.foreach_get("uv", corner_uvs)
    corner_uvs = corner_uvs.reshape(-1, 2) * np.repeat(polygon_scale, loop_totals)[:, None].astype(np.float32)
    layer.data.foreach_set("uv", corner_uvs.ravel())


def _average_island_scale(meshes) -> None:
    """Scales every island so texels per meter are the same everywhere (undoes projection foreshortening)."""
    with edit_mode(meshes):
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.select_all(action="SELECT")
        bpy.ops.uv.average_islands_scale()


def _pack(meshes, options) -> None:
    """Packs every island into the 0..1 texture square with the padding gap between them."""
    rotate, rotate_method = PACK_ROTATION[options.pack_rotate]
    margin = options.padding / float(options.texture_size)
    # Concave outlines pack tightest, but Blender's concave search slows down by an order of magnitude when
    # several objects are packed together (minutes for a dozen islands); convex outlines pack those as well.
    shape_method = "CONCAVE" if len(meshes) == 1 else "CONVEX"
    with edit_mode(meshes):
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.select_all(action="SELECT")
        bpy.ops.uv.pack_islands(rotate=rotate, rotate_method=rotate_method, scale=True,
                                margin_method="FRACTION", margin=margin, shape_method=shape_method,
                                merge_overlap=False)


def unwrap_smart(objects: list, options) -> dict:
    """
    Unwraps with Blender's Smart UV Project, then packs. Better than 'views' for organic shapes
    (characters, creatures, rocks) that have no meaningful front / side / top.

    :param objects: Mesh objects.
    :param options: Parsed options (smart_angle, padding, texture_size, pack_rotate).
    :returns: Layout statistics.
    """
    meshes = mesh_tools.mesh_objects(objects)
    for obj in meshes:
        ensure_new_uv_layer(obj)
    with edit_mode(meshes):
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(options.smart_angle), island_margin=0.0,
                                 area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    _average_island_scale(meshes)
    visibility = scale_islands_by_visibility(meshes, options.hidden_density)
    _pack(meshes, options)
    statistics = layout_statistics(objects)
    statistics["method"] = "smart"
    statistics["visibility"] = visibility
    return statistics


def keep_existing_layout(objects: list) -> dict:
    """
    Copies the current render UV layer into the working layer so later steps treat it like a new layout.

    :param objects: Mesh objects.
    :returns: Layout statistics.
    :raises RuntimeError: when a mesh has no UV layer to keep.
    """
    for obj in mesh_tools.mesh_objects(objects):
        layers = obj.data.uv_layers
        source = next((layer for layer in layers if layer.active_render), None) or layers.active
        if source is None:
            raise RuntimeError(f"'{obj.name}' has no UV layer; --unwrap keep needs one (use views or smart)")
        corner_uvs = np.empty(len(obj.data.loops) * 2, dtype=np.float32)
        source.data.foreach_get("uv", corner_uvs)
        ensure_new_uv_layer(obj).data.foreach_set("uv", corner_uvs)
    statistics = layout_statistics(objects)
    statistics["method"] = "keep"
    return statistics


def layout_statistics(objects: list) -> dict:
    """
    Measures the working layout: island count and how much of the texture square islands cover.

    :param objects: Mesh objects with the working UV layer.
    :returns: {islands, uv_coverage_percent, overlap_percent}.
    """
    meshes = mesh_tools.mesh_objects(objects)
    triangles = mesh_tools.collect_triangles(meshes, (NEW_UV_LAYER,))
    pixels = triangles.uvs[NEW_UV_LAYER].astype(np.float64) * OVERLAP_CHECK_RESOLUTION
    count, _ = rasterizer.rasterize_coverage_count(pixels, OVERLAP_CHECK_RESOLUTION, OVERLAP_CHECK_RESOLUTION)
    covered = rasterizer.rasterize_mask(pixels, OVERLAP_CHECK_RESOLUTION, OVERLAP_CHECK_RESOLUTION).ravel()
    island_total = 0
    for obj in meshes:
        island_total += _uv_island_count(obj)
    return {
        "islands": island_total,
        "uv_coverage_percent": round(100.0 * covered.mean(), 1),
        "overlap_percent": round(100.0 * (count > 1).sum() / max(covered.sum(), 1), 2),
    }


def _uv_island_count(obj) -> int:
    """Counts the UV islands of the working layer."""
    mesh = obj.data
    if mesh.uv_layers.get(NEW_UV_LAYER) is None or len(mesh.polygons) == 0:
        return 0
    return int(uv_islands(obj).max()) + 1


def finalize_uv_layers(objects: list) -> None:
    """
    Removes every UV layer except the new one and renames it to the standard name, so exporters write a
    single TEXCOORD_0.

    :param objects: Mesh objects.
    """
    for obj in mesh_tools.mesh_objects(objects):
        layers = obj.data.uv_layers
        for layer in [layer for layer in layers if layer.name != NEW_UV_LAYER]:
            layers.remove(layer)
        new_layer = layers.get(NEW_UV_LAYER)
        if new_layer is not None:
            new_layer.name = FINAL_UV_LAYER
            layers.active = new_layer
            new_layer.active_render = True
