"""
Model import and export for bt-unwrap. The input and output formats are picked from the file extension, so
the pipeline works the same on GLB, glTF, FBX, OBJ, USD, PLY, STL, Alembic and .blend files.
"""
import os

import bpy

IMPORT_EXTENSIONS = (".glb", ".gltf", ".fbx", ".obj", ".usd", ".usda", ".usdc", ".usdz", ".ply", ".stl",
                     ".abc", ".blend")
EXPORT_EXTENSIONS = (".glb", ".gltf", ".fbx", ".obj", ".usd", ".usda", ".usdc", ".usdz", ".blend")

# glTF exporter image formats by the --image-format option.
GLTF_IMAGE_FORMAT = {"png": "AUTO", "jpeg": "JPEG", "webp": "WEBP"}


def _operator_keywords(operator, wanted: dict) -> dict:
    """Keeps only the keyword arguments this Blender build's operator actually has (names move between
    versions)."""
    available = {prop.identifier for prop in operator.get_rna_type().properties}
    return {name: value for name, value in wanted.items() if name in available}


def _call_operator(operator, description: str, **keywords) -> None:
    """Runs an operator and raises when Blender reports it did not finish (operators do not raise on
    cancel)."""
    result = operator(**_operator_keywords(operator, keywords))
    if "FINISHED" not in result:
        raise RuntimeError(f"{description} failed: {result}")


def import_model(path: str) -> list:
    """
    Imports a model into an empty scene.

    :param path: Model file; the extension picks the importer.
    :returns: Every object the import created.
    :raises ValueError: for an unsupported extension.
    :raises RuntimeError: when the importer fails or brings in no mesh.
    """
    extension = os.path.splitext(path)[1].lower()
    if extension not in IMPORT_EXTENSIONS:
        raise ValueError(f"unsupported input format '{extension}'. Supported: {', '.join(IMPORT_EXTENSIONS)}")
    if not os.path.isfile(path):
        raise RuntimeError(f"input file not found: {path}")

    if extension == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        _import_by_extension(path, extension)

    objects = list(bpy.context.scene.objects)
    if not any(obj.type == "MESH" for obj in objects):
        raise RuntimeError(f"'{path}' contains no mesh objects")
    return objects


def _import_by_extension(path: str, extension: str) -> None:
    """Dispatches to the importer for one file type."""
    if extension in (".glb", ".gltf"):
        _call_operator(bpy.ops.import_scene.gltf, "glTF import", filepath=path)
    elif extension == ".fbx":
        _call_operator(bpy.ops.import_scene.fbx, "FBX import", filepath=path, use_custom_normals=True)
    elif extension == ".obj":
        _call_operator(bpy.ops.wm.obj_import, "OBJ import", filepath=path)
    elif extension in (".usd", ".usda", ".usdc", ".usdz"):
        _call_operator(bpy.ops.wm.usd_import, "USD import", filepath=path)
    elif extension == ".ply":
        _call_operator(bpy.ops.wm.ply_import, "PLY import", filepath=path)
    elif extension == ".stl":
        _call_operator(bpy.ops.wm.stl_import, "STL import", filepath=path)
    elif extension == ".abc":
        _call_operator(bpy.ops.wm.alembic_import, "Alembic import", filepath=path)


def export_model(path: str, objects: list, image_format: str, jpeg_quality: int, draco: bool = False,
                 tangents: bool = False) -> str:
    """
    Exports the given objects (and nothing else) to one file.

    :param path: Output file; the extension picks the exporter. .glb embeds textures, .gltf writes them beside it.
    :param objects: Objects to export; their parents and children must be in the list too.
    :param image_format: png, jpeg or webp — how glTF stores its textures.
    :param jpeg_quality: 0..100 quality for JPEG / WebP textures.
    :param draco: Draco-compress glTF / GLB geometry.
    :param tangents: Write MikkTSpace tangents (glTF), so engines read the baked normal map exactly as it
        was baked instead of generating their own tangents.
    :returns: The path written.
    :raises ValueError: for an unsupported extension.
    """
    extension = os.path.splitext(path)[1].lower()
    if extension not in EXPORT_EXTENSIONS:
        raise ValueError(f"unsupported output format '{extension}'. Supported: {', '.join(EXPORT_EXTENSIONS)}")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next((obj for obj in objects if obj.type == "MESH"), None)

    if extension in (".glb", ".gltf"):
        _call_operator(
            bpy.ops.export_scene.gltf, "glTF export",
            filepath=path,
            export_format="GLB" if extension == ".glb" else "GLTF_SEPARATE",
            use_selection=True,
            export_apply=True,
            export_yup=True,
            export_texcoords=True,
            export_normals=True,
            export_tangents=tangents,
            export_materials="EXPORT",
            export_image_format=GLTF_IMAGE_FORMAT.get(image_format, "AUTO"),
            export_jpeg_quality=jpeg_quality,
            export_image_quality=jpeg_quality,
            export_draco_mesh_compression_enable=draco,
            export_extras=True,
        )
    elif extension == ".fbx":
        _call_operator(
            bpy.ops.export_scene.fbx, "FBX export",
            filepath=path, use_selection=True, add_leaf_bones=False, path_mode="COPY", embed_textures=True,
            apply_unit_scale=True, bake_space_transform=False,
        )
    elif extension == ".obj":
        _call_operator(bpy.ops.wm.obj_export, "OBJ export", filepath=path, export_selected_objects=True,
                       export_materials=True, path_mode="COPY")
    elif extension in (".usd", ".usda", ".usdc", ".usdz"):
        _call_operator(bpy.ops.wm.usd_export, "USD export", filepath=path, selected_objects_only=True,
                       export_textures=True, relative_paths=True)
    elif extension == ".blend":
        bpy.ops.file.pack_all()
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)
    return path
