"""
Mesh helpers for bt-unwrap: read triangles into numpy, find connected parts, clean up AI-generated
geometry, decimate to a face budget, set shading, and move / rotate / scale whole models.
"""
import math
from dataclasses import dataclass, field
from typing import Optional

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

# Rotation about +Z that turns a model whose front faces the given axis so it faces Blender -Y
# (Blender -Y is glTF +Z, the glTF and BabylonJS forward direction).
FORWARD_ROTATION_DEGREES = {"-y": 0.0, "+x": -90.0, "+y": 180.0, "-x": 90.0}


@dataclass
class TriangleSet:
    """Every triangle of a group of mesh objects, in world space."""

    positions: np.ndarray                       # float64 (count, 3, 3) corner positions
    corner_normals: np.ndarray                  # float32 (count, 3, 3) shading normals per corner
    face_normals: np.ndarray                    # float32 (count, 3) geometric normals
    material_index: np.ndarray                  # int32 (count,) material slot per triangle
    object_index: np.ndarray                    # int32 (count,) index into the object list
    polygon_index: np.ndarray                   # int64 (count,) source polygon in its own mesh
    vertex_index: np.ndarray                    # int64 (count, 3) vertices, numbered across all objects in order
    uvs: dict = field(default_factory=dict)     # uv layer name -> float32 (count, 3, 2)

    @property
    def count(self) -> int:
        """Number of triangles."""
        return self.positions.shape[0]


def mesh_objects(objects: list) -> list:
    """
    Filters a list down to mesh objects.

    :param objects: Any Blender objects.
    :returns: Only the objects whose type is MESH.
    """
    return [obj for obj in objects if obj.type == "MESH"]


def count_triangles(objects: list) -> int:
    """
    Counts the triangles the given meshes will have once triangulated.

    :param objects: Mesh objects.
    :returns: Total triangle count.
    """
    total = 0
    for obj in mesh_objects(objects):
        loop_totals = np.empty(len(obj.data.polygons), dtype=np.int64)
        obj.data.polygons.foreach_get("loop_total", loop_totals)
        total += int((loop_totals - 2).sum())
    return total


def collect_triangles(objects: list, uv_layer_names: tuple = ()) -> TriangleSet:
    """
    Reads every triangle of the given meshes into world-space numpy arrays.

    :param objects: Mesh objects (others are skipped).
    :param uv_layer_names: UV layers to read per corner; a missing layer reads as zeros.
    :returns: A TriangleSet with positions, normals, material and source indices.
    """
    parts = {"positions": [], "corner_normals": [], "face_normals": [], "material_index": [],
             "object_index": [], "polygon_index": [], "vertex_index": []}
    uv_parts = {name: [] for name in uv_layer_names}
    vertex_offset = 0
    for object_number, obj in enumerate(mesh_objects(objects)):
        mesh = obj.data
        mesh.calc_loop_triangles()
        triangle_count = len(mesh.loop_triangles)
        if triangle_count == 0:
            vertex_offset += len(mesh.vertices)
            continue
        vertex_index = np.empty(triangle_count * 3, dtype=np.int64)
        loop_index = np.empty(triangle_count * 3, dtype=np.int64)
        polygon_index = np.empty(triangle_count, dtype=np.int64)
        mesh.loop_triangles.foreach_get("vertices", vertex_index)
        mesh.loop_triangles.foreach_get("loops", loop_index)
        mesh.loop_triangles.foreach_get("polygon_index", polygon_index)

        coordinates = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
        mesh.vertices.foreach_get("co", coordinates)
        world_matrix = np.array(obj.matrix_world, dtype=np.float64)
        world_coordinates = coordinates.reshape(-1, 3) @ world_matrix[:3, :3].T + world_matrix[:3, 3]

        normal_matrix = np.array(obj.matrix_world.to_3x3().inverted_safe().transposed(), dtype=np.float64)
        loop_normals = np.empty(len(mesh.loops) * 3, dtype=np.float32)
        mesh.corner_normals.foreach_get("vector", loop_normals)
        world_normals = _normalize(loop_normals.reshape(-1, 3) @ normal_matrix.T)

        positions = world_coordinates[vertex_index].reshape(triangle_count, 3, 3)
        edge_one = positions[:, 1] - positions[:, 0]
        edge_two = positions[:, 2] - positions[:, 0]
        parts["positions"].append(positions)
        parts["corner_normals"].append(world_normals[loop_index].reshape(triangle_count, 3, 3).astype(np.float32))
        parts["face_normals"].append(_normalize(np.cross(edge_one, edge_two)).astype(np.float32))

        material_per_polygon = np.empty(len(mesh.polygons), dtype=np.int32)
        mesh.polygons.foreach_get("material_index", material_per_polygon)
        parts["material_index"].append(material_per_polygon[polygon_index])
        parts["object_index"].append(np.full(triangle_count, object_number, dtype=np.int32))
        parts["polygon_index"].append(polygon_index)
        parts["vertex_index"].append(vertex_index.reshape(triangle_count, 3) + vertex_offset)
        vertex_offset += len(mesh.vertices)

        for name in uv_layer_names:
            layer = mesh.uv_layers.get(name)
            corner_uvs = np.zeros(len(mesh.loops) * 2, dtype=np.float32)
            if layer is not None:
                layer.data.foreach_get("uv", corner_uvs)
            uv_parts[name].append(corner_uvs.reshape(-1, 2)[loop_index].reshape(triangle_count, 3, 2))

    if not parts["positions"]:
        raise RuntimeError("the model has no triangles")
    return TriangleSet(
        positions=np.concatenate(parts["positions"]),
        corner_normals=np.concatenate(parts["corner_normals"]),
        face_normals=np.concatenate(parts["face_normals"]),
        material_index=np.concatenate(parts["material_index"]),
        object_index=np.concatenate(parts["object_index"]),
        polygon_index=np.concatenate(parts["polygon_index"]),
        vertex_index=np.concatenate(parts["vertex_index"]),
        uvs={name: np.concatenate(chunks) for name, chunks in uv_parts.items()},
    )


def smoothed_vertex_normals(objects: list, iterations: int) -> np.ndarray:
    """
    Vertex normals averaged over their neighbourhood, so a lumpy AI-generated surface reports the overall
    direction a panel faces instead of every bump. Numbered like TriangleSet.vertex_index.

    :param objects: Mesh objects, in the same order as given to collect_triangles.
    :param iterations: Averaging passes; each widens the neighbourhood by one edge ring.
    :returns: float32 array (vertex_count, 3) of unit world-space normals.
    """
    chunks = []
    for obj in mesh_objects(objects):
        mesh = obj.data
        normals = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
        mesh.vertices.foreach_get("normal", normals)
        normal_matrix = np.array(obj.matrix_world.to_3x3().inverted_safe().transposed(), dtype=np.float64)
        normals = _normalize(normals.reshape(-1, 3) @ normal_matrix.T)
        edges = np.empty(len(mesh.edges) * 2, dtype=np.int64)
        mesh.edges.foreach_get("vertices", edges)
        edges = edges.reshape(-1, 2)
        for _ in range(iterations):
            summed = normals.copy()
            np.add.at(summed, edges[:, 0], normals[edges[:, 1]])
            np.add.at(summed, edges[:, 1], normals[edges[:, 0]])
            normals = _normalize(summed)
        chunks.append(normals.astype(np.float32))
    return np.concatenate(chunks) if chunks else np.zeros((0, 3), dtype=np.float32)


def _normalize(vectors: np.ndarray) -> np.ndarray:
    """Scales each row vector to unit length; zero vectors stay zero."""
    lengths = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.maximum(lengths, 1e-20)


def polygon_adjacency(mesh: bpy.types.Mesh) -> np.ndarray:
    """
    Lists pairs of polygons that share an edge.

    :param mesh: The mesh to read.
    :returns: int64 array (pair_count, 2) of polygon indices.
    """
    pairs, _ = polygon_adjacency_with_edges(mesh)
    return pairs


def polygon_adjacency_with_edges(mesh: bpy.types.Mesh) -> tuple:
    """
    Lists pairs of polygons that share an edge, together with that edge.

    :param mesh: The mesh to read.
    :returns: (int64 array (pair_count, 2) of polygon indices, int64 array (pair_count,) of edge indices).
    """
    loop_edge = np.empty(len(mesh.loops), dtype=np.int64)
    mesh.loops.foreach_get("edge_index", loop_edge)
    loop_totals = np.empty(len(mesh.polygons), dtype=np.int64)
    mesh.polygons.foreach_get("loop_total", loop_totals)
    polygon_of_loop = np.repeat(np.arange(len(mesh.polygons), dtype=np.int64), loop_totals)
    order = np.argsort(loop_edge, kind="stable")
    sorted_edges = loop_edge[order]
    sorted_polygons = polygon_of_loop[order]
    same_edge = sorted_edges[1:] == sorted_edges[:-1]
    pairs = np.stack((sorted_polygons[:-1][same_edge], sorted_polygons[1:][same_edge]), axis=1)
    return pairs, sorted_edges[1:][same_edge]


def connected_components(element_count: int, pairs: np.ndarray) -> np.ndarray:
    """
    Labels the connected components of a graph given as an edge list.

    :param element_count: Number of nodes.
    :param pairs: int64 array (pair_count, 2) of connected node indices.
    :returns: int64 array (element_count,) — each node's component, the smallest node index in it.
    """
    labels = np.arange(element_count, dtype=np.int64)
    if pairs.size == 0:
        return labels
    first, second = pairs[:, 0], pairs[:, 1]
    while True:
        updated = labels.copy()
        np.minimum.at(updated, first, labels[second])
        np.minimum.at(updated, second, labels[first])
        updated = updated[updated]
        if np.array_equal(updated, labels):
            return labels
        labels = updated


def temp_override_for(objects: list, active=None):
    """
    Builds a context override that makes operators see the given objects as selected and the given (or
    first) one as active.

    :param objects: Objects to treat as selected.
    :param active: Object to treat as active; defaults to the first.
    :returns: A context manager for `with`.
    """
    active_object = active or objects[0]
    return bpy.context.temp_override(object=active_object, active_object=active_object,
                                     selected_objects=objects, selected_editable_objects=objects)


def join_meshes(objects: list) -> bpy.types.Object:
    """
    Joins all mesh objects into one, bakes its world transform into the vertices and deletes the empty
    hierarchy left behind. AI generators often export one mesh under several empty nodes.

    :param objects: Every object in the scene.
    :returns: The single joined mesh object, with an identity transform.
    """
    meshes = mesh_objects(objects)
    target = meshes[0]
    for obj in meshes:
        world_matrix = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world_matrix
    if len(meshes) > 1:
        with temp_override_for(meshes, target):
            bpy.ops.object.join()
    with temp_override_for([target]):
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for obj in list(bpy.context.scene.objects):
        if obj != target and obj.type != "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)
    target.name = "Model"
    return target


def cleanup_mesh(obj: bpy.types.Object, merge_distance: float, debris_faces: int, fix_normals: bool,
                 fill_hole_sides: int) -> dict:
    """
    Repairs the usual AI-mesh faults in place: duplicate vertices, zero-area faces, loose vertices and
    edges, small floating debris, open holes and inconsistent face winding.

    :param obj: A mesh object.
    :param merge_distance: Vertices closer than this (meters) are merged.
    :param debris_faces: Connected parts with fewer faces than this are deleted (0 keeps everything).
    :param fix_normals: Recalculate face winding so every normal points outward.
    :param fill_hole_sides: Fill open holes with at most this many edges (0 leaves holes open).
    :returns: Counts of what was removed or changed.
    """
    mesh = obj.data
    vertices_before = len(mesh.vertices)
    faces_before = len(mesh.polygons)

    editor = bmesh.new()
    editor.from_mesh(mesh)
    bmesh.ops.remove_doubles(editor, verts=editor.verts, dist=merge_distance)
    bmesh.ops.dissolve_degenerate(editor, dist=merge_distance, edges=editor.edges)
    _delete_loose(editor)
    editor.to_mesh(mesh)
    editor.free()

    debris_removed = 0
    if debris_faces > 0 and len(mesh.polygons) > 0:
        components = connected_components(len(mesh.polygons), polygon_adjacency(mesh))
        _, inverse, sizes = np.unique(components, return_inverse=True, return_counts=True)
        is_debris = sizes[inverse] < debris_faces
        if is_debris.any() and not is_debris.all():
            debris_removed = int(is_debris.sum())
            editor = bmesh.new()
            editor.from_mesh(mesh)
            editor.faces.ensure_lookup_table()
            doomed = [editor.faces[index] for index in np.flatnonzero(is_debris)]
            bmesh.ops.delete(editor, geom=doomed, context="FACES")
            _delete_loose(editor)
            editor.to_mesh(mesh)
            editor.free()

    holes_filled = 0
    editor = bmesh.new()
    editor.from_mesh(mesh)
    if fill_hole_sides > 0:
        boundary = [edge for edge in editor.edges if edge.is_boundary]
        result = bmesh.ops.holes_fill(editor, edges=boundary, sides=fill_hole_sides)
        holes_filled = len(result.get("faces", []))
    if fix_normals:
        bmesh.ops.recalc_face_normals(editor, faces=editor.faces)
    editor.to_mesh(mesh)
    editor.free()
    mesh.update()

    return {
        "vertices_merged": vertices_before - len(mesh.vertices),
        "faces_before": faces_before,
        "faces_after": len(mesh.polygons),
        "debris_faces_removed": debris_removed,
        "hole_faces_added": holes_filled,
        "normals_recalculated": fix_normals,
    }


def _delete_loose(editor: bmesh.types.BMesh) -> None:
    """Deletes edges and vertices that belong to no face."""
    loose_edges = [edge for edge in editor.edges if not edge.link_faces]
    if loose_edges:
        bmesh.ops.delete(editor, geom=loose_edges, context="EDGES")
    loose_vertices = [vertex for vertex in editor.verts if not vertex.link_faces]
    if loose_vertices:
        bmesh.ops.delete(editor, geom=loose_vertices, context="VERTS")


def duplicate_object(obj: bpy.types.Object, name: str) -> bpy.types.Object:
    """
    Copies an object with its own mesh data (materials are shared) into the scene.

    :param obj: The object to copy.
    :param name: Name for the copy.
    :returns: The new object.
    """
    copy = obj.copy()
    copy.data = obj.data.copy()
    copy.name = name
    for collection in obj.users_collection:
        collection.objects.link(copy)
    return copy


def detached_copy(obj: bpy.types.Object, name: str) -> bpy.types.Object:
    """
    Copies an object with its own mesh data, unparented but in the same world place, so removing or joining
    the original hierarchy later cannot move it.

    :param obj: The object to copy.
    :param name: Name for the copy.
    :returns: The new object.
    """
    world_matrix = obj.matrix_world.copy()
    copy = duplicate_object(obj, name)
    copy.parent = None
    copy.matrix_world = world_matrix
    return copy


def decimate_to_triangles(obj: bpy.types.Object, target_triangles: int) -> int:
    """
    Reduces a mesh to about the target triangle count with a collapse decimation, keeping UVs.
    Nothing happens when the mesh already has fewer triangles.

    :param obj: A mesh object.
    :param target_triangles: Desired triangle count.
    :returns: The triangle count afterwards.
    """
    current = count_triangles([obj])
    if target_triangles <= 0 or current <= target_triangles:
        return current
    modifier = obj.modifiers.new("BtUnwrapDecimate", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = target_triangles / current
    modifier.use_collapse_triangulate = True
    with temp_override_for([obj]):
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return count_triangles([obj])


def apply_shading(objects: list, mode: str, smooth_angle_degrees: float) -> None:
    """
    Sets face shading. AI meshes usually ship broken or missing split normals, so any mode other than
    'keep' clears custom normals first.

    :param objects: Mesh objects.
    :param mode: auto (smooth with sharp edges above the angle), smooth, flat, or keep.
    :param smooth_angle_degrees: Edge angle above which 'auto' keeps a hard edge.
    """
    if mode == "keep":
        return
    for obj in mesh_objects(objects):
        with temp_override_for([obj]):
            if obj.data.has_custom_normals:
                bpy.ops.mesh.customdata_custom_splitnormals_clear()
            if mode == "auto":
                bpy.ops.object.shade_smooth_by_angle(angle=math.radians(smooth_angle_degrees), keep_sharp_edges=True)
            elif mode == "smooth":
                bpy.ops.object.shade_smooth()
            elif mode == "flat":
                bpy.ops.object.shade_flat()


def world_vertex_positions(objects: list) -> np.ndarray:
    """
    Reads every vertex of the given meshes in world space.

    :param objects: Mesh objects.
    :returns: float64 array (vertex_count, 3).
    """
    chunks = []
    for obj in mesh_objects(objects):
        coordinates = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
        obj.data.vertices.foreach_get("co", coordinates)
        world_matrix = np.array(obj.matrix_world, dtype=np.float64)
        chunks.append(coordinates.reshape(-1, 3) @ world_matrix[:3, :3].T + world_matrix[:3, 3])
    return np.concatenate(chunks) if chunks else np.zeros((0, 3))


def model_bounds(objects: list) -> tuple:
    """
    Computes the world-space axis-aligned bounds of the given meshes.

    :param objects: Mesh objects.
    :returns: (minimum, maximum) as numpy float64 3-vectors.
    """
    positions = world_vertex_positions(objects)
    return positions.min(axis=0), positions.max(axis=0)


def transform_model(objects: list, matrix: Matrix) -> None:
    """
    Applies a world-space transform to a whole model by moving its top-level objects, so parent / child
    pivots (wheels, doors) keep their local transforms.

    :param objects: Every object of the model.
    :param matrix: 4x4 world transform to apply on top of the current placement.
    """
    object_set = set(objects)
    for obj in objects:
        if obj.parent is None or obj.parent not in object_set:
            obj.matrix_world = matrix @ obj.matrix_world


def rotation_from_euler_degrees(text: Optional[str]) -> Matrix:
    """
    Parses an "x,y,z" rotation in degrees.

    :param text: Comma-separated degrees, or None for no rotation.
    :returns: A 4x4 rotation matrix.
    :raises ValueError: when the text is not three numbers.
    """
    if not text:
        return Matrix.Identity(4)
    values = [float(part) for part in text.split(",")]
    if len(values) != 3:
        raise ValueError(f"--rotate expects three comma-separated degrees, got '{text}'")
    radians = tuple(math.radians(value) for value in values)
    return Euler(radians, "XYZ").to_matrix().to_4x4()


def forward_rotation(forward_axis: str) -> Matrix:
    """
    Builds the rotation that turns a model facing the given axis so it faces Blender -Y (glTF +Z).

    :param forward_axis: One of +x, -x, +y, -y.
    :returns: A 4x4 rotation about +Z.
    """
    return Matrix.Rotation(math.radians(FORWARD_ROTATION_DEGREES[forward_axis]), 4, "Z")


def scale_and_origin_matrix(objects: list, length: float, width: float, height: float, origin: str) -> tuple:
    """
    Builds the transform that scales a model already facing -Y to a real-world size and moves its origin.

    :param objects: Mesh objects of the model.
    :param length: Front-to-back size in meters along Y (0 = keep).
    :param width: Side-to-side size in meters along X (0 = keep).
    :param height: Vertical size in meters along Z (0 = keep).
    :param origin: bottom (center of the footprint at floor level), center, or keep.
    :returns: (4x4 matrix, the uniform scale factor used).
    """
    minimum, maximum = model_bounds(objects)
    size = maximum - minimum
    scale_factor = 1.0
    if length > 0 and size[1] > 0:
        scale_factor = length / size[1]
    elif height > 0 and size[2] > 0:
        scale_factor = height / size[2]
    elif width > 0 and size[0] > 0:
        scale_factor = width / size[0]
    center = (minimum + maximum) / 2.0
    if origin == "bottom":
        anchor = Vector((center[0], center[1], minimum[2]))
    elif origin == "center":
        anchor = Vector(center.tolist())
    else:
        anchor = Vector((0.0, 0.0, 0.0))
    matrix = Matrix.Scale(scale_factor, 4) @ Matrix.Translation(-anchor)
    return matrix, scale_factor
