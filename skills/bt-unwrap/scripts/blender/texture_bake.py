"""
Cycles baking for bt-unwrap: transfer the source model's base color, metallic-roughness and normal detail
onto the new UV layout, and build the final single-material PBR setup the exporters understand.

The source is a copy of the model taken before decimation and before the new layout, so the bake reads the
full-detail surface with its original textures and writes into the new, clean layout. Normal maps are baked
in the new layout's own tangent space, which is why they stay correct after re-unwrapping.
"""
from contextlib import contextmanager

import bpy

import image_utils
import mesh_tools
import uv_layout

BAKE_MATERIAL_NAME = "BtUnwrapBakeTarget"
GPU_DEVICE_TYPES = ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI")


def find_principled(material: bpy.types.Material):
    """
    Finds the Principled BSDF that feeds a material's output.

    :param material: Any material.
    :returns: The Principled BSDF node, or None.
    """
    if material is None or not material.use_nodes:
        return None
    return next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)


def _linked_source(socket):
    """The output socket feeding an input socket, or None when it is unlinked."""
    return socket.links[0].from_socket if socket.is_linked else None


def _image_feeds(socket, depth: int = 0) -> bool:
    """True when an image texture (or vertex colors) feeds this input somewhere upstream — importers often
    wire empty normal-map or bump nodes that carry no data."""
    if depth > 12 or not socket.is_linked:
        return False
    node = socket.links[0].from_node
    if node.type in ("TEX_IMAGE", "VERTEX_COLOR", "ATTRIBUTE"):
        return True
    return any(_image_feeds(upstream, depth + 1) for upstream in node.inputs)


def describe_source_materials(objects: list) -> dict:
    """
    Reports what the source materials carry, to decide which maps are worth baking.

    :param objects: Source mesh objects.
    :returns: {has_color_texture, has_vertex_colors, has_metallic_roughness_texture, has_normal_map,
               material_count}.
    """
    summary = {"has_color_texture": False, "has_vertex_colors": False, "has_metallic_roughness_texture": False,
               "has_normal_map": False, "material_count": 0}
    seen = set()
    for obj in mesh_tools.mesh_objects(objects):
        if obj.data.color_attributes:
            summary["has_vertex_colors"] = True
        for slot in obj.material_slots:
            material = slot.material
            if material is None or material.name in seen:
                continue
            seen.add(material.name)
            principled = find_principled(material)
            if principled is None:
                continue
            summary["has_color_texture"] |= _image_feeds(principled.inputs["Base Color"])
            summary["has_metallic_roughness_texture"] |= (_image_feeds(principled.inputs["Roughness"]) or
                                                          _image_feeds(principled.inputs["Metallic"]))
            summary["has_normal_map"] |= _image_feeds(principled.inputs["Normal"])
    summary["material_count"] = len(seen)
    return summary


def source_base_color(objects: list) -> tuple:
    """
    The constant base color of the first source material, used when there is no color data to bake.

    :param objects: Source mesh objects.
    :returns: RGBA tuple (linear, as Blender stores node colors).
    """
    for obj in mesh_tools.mesh_objects(objects):
        for slot in obj.material_slots:
            principled = find_principled(slot.material)
            if principled is not None:
                return tuple(principled.inputs["Base Color"].default_value)
    return (0.8, 0.8, 0.8, 1.0)


def ensure_source_materials(objects: list) -> None:
    """
    Gives material-less source meshes a material, wiring their vertex colors in when they have them
    (PLY / OBJ scans and some generators ship vertex colors instead of textures).

    :param objects: Source mesh objects.
    """
    for obj in mesh_tools.mesh_objects(objects):
        if any(slot.material for slot in obj.material_slots):
            continue
        material = bpy.data.materials.new(f"{obj.name}_Source")
        material.use_nodes = True
        principled = find_principled(material)
        color_attribute = obj.data.color_attributes.active_color
        if principled is not None and color_attribute is not None:
            attribute_node = material.node_tree.nodes.new("ShaderNodeVertexColor")
            attribute_node.layer_name = color_attribute.name
            material.node_tree.links.new(attribute_node.outputs["Color"], principled.inputs["Base Color"])
        obj.data.materials.clear()
        obj.data.materials.append(material)


def configure_cycles(samples: int, use_gpu: bool) -> str:
    """
    Switches the scene to Cycles for baking and picks a device.

    :param samples: Anti-aliasing samples per texel.
    :param use_gpu: Try a GPU first and fall back to the CPU when none is usable.
    :returns: The device actually used: 'GPU (<type>)' or 'CPU'.
    """
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = max(1, samples)
    scene.cycles.use_denoising = False
    scene.cycles.device = "CPU"
    if not use_gpu:
        return "CPU"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    for device_type in GPU_DEVICE_TYPES:
        try:
            preferences.compute_device_type = device_type
            preferences.get_devices()
        except TypeError:
            continue
        gpu_devices = [device for device in preferences.devices if device.type == device_type]
        if gpu_devices:
            for device in preferences.devices:
                device.use = device.type == device_type
            scene.cycles.device = "GPU"
            return f"GPU ({device_type})"
    return "CPU"


def _new_bake_image(name: str, size: int, is_color: bool) -> bpy.types.Image:
    """A blank 8-bit bake target; color maps are sRGB, data maps (normals, roughness) are Non-Color."""
    image = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    image.colorspace_settings.name = "sRGB" if is_color else "Non-Color"
    return image


def _assign_bake_target(target_objects: list, image: bpy.types.Image) -> None:
    """Gives every target mesh a single material whose active image node receives the bake."""
    material = bpy.data.materials.get(BAKE_MATERIAL_NAME) or bpy.data.materials.new(BAKE_MATERIAL_NAME)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    image_node = next((node for node in nodes if node.type == "TEX_IMAGE"), None) or nodes.new("ShaderNodeTexImage")
    image_node.image = image
    nodes.active = image_node
    for obj in target_objects:
        obj.data.materials.clear()
        obj.data.materials.append(material)


@contextmanager
def _emission_override(source_objects: list, channel: str):
    """
    Temporarily routes one material property straight into an emission shader on every source material,
    so an EMIT bake records exactly that property. Restores the original wiring afterwards.

    :param source_objects: Source meshes.
    :param channel: 'color' (base color) or 'metallic_roughness' (R=1, G=roughness, B=metallic as glTF packs it).
    """
    restorations = []
    seen = set()
    for obj in mesh_tools.mesh_objects(source_objects):
        for slot in obj.material_slots:
            material = slot.material
            if material is None or material.name in seen or not material.use_nodes:
                continue
            seen.add(material.name)
            tree = material.node_tree
            output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output),
                          None) or next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL"), None)
            if output is None:
                continue
            principled = find_principled(material)
            previous_surface = _linked_source(output.inputs["Surface"])
            emission = tree.nodes.new("ShaderNodeEmission")
            emission.inputs["Strength"].default_value = 1.0
            added_nodes = [emission]
            if channel == "color":
                _wire_color(tree, principled, emission)
            else:
                added_nodes.append(_wire_metallic_roughness(tree, principled, emission))
            tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
            restorations.append((tree, output, previous_surface, added_nodes))
    try:
        yield
    finally:
        for tree, output, previous_surface, added_nodes in restorations:
            for node in added_nodes:
                tree.nodes.remove(node)
            if previous_surface is not None:
                tree.links.new(previous_surface, output.inputs["Surface"])


@contextmanager
def _without_normal_maps(source_objects: list):
    """
    Temporarily unplugs the normal maps of every source material, so a normal bake records the surface's
    real shape only. Generated normal maps are mostly relief guessed from their own texture (embossed logos
    where the generator painted them, noise on smooth panels) and would fight the repainted texture.
    """
    unplugged = []
    seen = set()
    for obj in mesh_tools.mesh_objects(source_objects):
        for slot in obj.material_slots:
            material = slot.material
            if material is None or material.name in seen or not material.use_nodes:
                continue
            seen.add(material.name)
            principled = find_principled(material)
            if principled is None or not principled.inputs["Normal"].is_linked:
                continue
            link = principled.inputs["Normal"].links[0]
            unplugged.append((material.node_tree, link.from_socket, principled.inputs["Normal"]))
            material.node_tree.links.remove(link)
    try:
        yield
    finally:
        for tree, from_socket, to_socket in unplugged:
            tree.links.new(from_socket, to_socket)


def _wire_color(tree, principled, emission) -> None:
    """Feeds the base color (texture or constant) into the emission shader."""
    if principled is None:
        emission.inputs["Color"].default_value = (0.8, 0.8, 0.8, 1.0)
        return
    source = _linked_source(principled.inputs["Base Color"])
    if source is not None:
        tree.links.new(source, emission.inputs["Color"])
    else:
        emission.inputs["Color"].default_value = principled.inputs["Base Color"].default_value


def _wire_metallic_roughness(tree, principled, emission):
    """Packs roughness into green and metallic into blue (glTF layout) and feeds it to the emission shader."""
    combine = tree.nodes.new("ShaderNodeCombineColor")
    combine.inputs["Red"].default_value = 1.0
    for input_name, channel_name in (("Roughness", "Green"), ("Metallic", "Blue")):
        if principled is None:
            combine.inputs[channel_name].default_value = 0.5 if input_name == "Roughness" else 0.0
            continue
        source = _linked_source(principled.inputs[input_name])
        if source is not None:
            tree.links.new(source, combine.inputs[channel_name])
        else:
            combine.inputs[channel_name].default_value = principled.inputs[input_name].default_value
    tree.links.new(combine.outputs["Color"], emission.inputs["Color"])
    return combine


def _run_bake(target_objects: list, source_objects: list, bake_type: str, distance: float, padding: int) -> None:
    """Runs one selected-to-active Cycles bake from the sources onto the targets' new UV layout."""
    bpy.ops.object.select_all(action="DESELECT")
    for obj in source_objects + target_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = target_objects[0]
    keywords = {
        "type": bake_type,
        "use_selected_to_active": True,
        "cage_extrusion": distance,
        "max_ray_distance": distance * 2.0,
        "margin": padding,
        "margin_type": "EXTEND",
        "use_clear": True,
        "target": "IMAGE_TEXTURES",
        "uv_layer": uv_layout.NEW_UV_LAYER,
    }
    if bake_type == "NORMAL":
        keywords["normal_space"] = "TANGENT"
    result = bpy.ops.object.bake(**keywords)
    if "FINISHED" not in result:
        raise RuntimeError(f"Cycles {bake_type} bake failed: {result}")


def bake_source_maps(target_objects: list, source_objects: list, size: int, distance: float, padding: int,
                     maps: tuple, keep_source_normal_map: bool = False) -> dict:
    """
    Bakes the requested maps from the source copy onto the targets' new layout.

    :param target_objects: Meshes with the new UV layer (their materials are replaced).
    :param source_objects: Full-detail copies with the original UVs and materials.
    :param size: Texture size in pixels (square).
    :param distance: Cage extrusion in meters; rays search twice this far for the source surface.
    :param padding: Pixels of edge padding around islands.
    :param maps: Any of 'color', 'metallic_roughness', 'normal'.
    :param keep_source_normal_map: Bake the source's own normal map into the result too. Off by default: the
        normal bake then records only the source's geometric detail.
    :returns: map name -> float32 array (size, size, 4), row 0 at the bottom.
    """
    results = {}
    for map_name in maps:
        image = _new_bake_image(f"bake_{map_name}", size, is_color=map_name == "color")
        _assign_bake_target(target_objects, image)
        if map_name == "normal" and keep_source_normal_map:
            _run_bake(target_objects, source_objects, "NORMAL", distance, padding)
        elif map_name == "normal":
            with _without_normal_maps(source_objects):
                _run_bake(target_objects, source_objects, "NORMAL", distance, padding)
        else:
            with _emission_override(source_objects, map_name):
                _run_bake(target_objects, source_objects, "EMIT", distance, padding)
        results[map_name] = image_utils.read_blender_image(image)
        bpy.data.images.remove(image)
    return results


def build_final_material(target_objects: list, name: str, texture_paths: dict, roughness, metallic,
                         constant_color: tuple = (0.8, 0.8, 0.8, 1.0), double_sided: bool = False) -> bpy.types.Material:
    """
    Creates the single PBR material the model ships with, arranged the way the glTF exporter recognises:
    base color image -> Base Color; metallic-roughness image -> Separate Color (G roughness, B metallic);
    normal image -> Normal Map node. Replaces every material on the targets.

    :param target_objects: Final meshes.
    :param name: Material name.
    :param texture_paths: Saved texture files: any of 'color', 'metallic_roughness', 'normal'.
    :param roughness: Constant roughness to use instead of a map, or None.
    :param metallic: Constant metallic to use instead of a map, or None.
    :param constant_color: Base color (linear RGBA) used when there is no color texture.
    :param double_sided: Render back faces too. Off by default: a closed model never shows them, and culling
        them halves the shading work (glTF doubleSided follows this).
    :returns: The material.
    """
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.use_backface_culling = not double_sided
    tree = material.node_tree
    principled = find_principled(material)
    principled.inputs["Base Color"].default_value = constant_color

    color_node = None
    if "color" in texture_paths:
        color_node = _image_node(tree, texture_paths["color"], is_color=True, location=(-600, 300))
        tree.links.new(color_node.outputs["Color"], principled.inputs["Base Color"])
    if "metallic_roughness" in texture_paths and (roughness is None or metallic is None):
        packed_node = _image_node(tree, texture_paths["metallic_roughness"], is_color=False, location=(-600, 0))
        separate = tree.nodes.new("ShaderNodeSeparateColor")
        separate.location = (-300, 0)
        tree.links.new(packed_node.outputs["Color"], separate.inputs["Color"])
        if roughness is None:
            tree.links.new(separate.outputs["Green"], principled.inputs["Roughness"])
        if metallic is None:
            tree.links.new(separate.outputs["Blue"], principled.inputs["Metallic"])
    if roughness is not None:
        principled.inputs["Roughness"].default_value = roughness
    if metallic is not None:
        principled.inputs["Metallic"].default_value = metallic
    if "normal" in texture_paths:
        normal_image_node = _image_node(tree, texture_paths["normal"], is_color=False, location=(-600, -300))
        normal_map = tree.nodes.new("ShaderNodeNormalMap")
        normal_map.location = (-300, -300)
        normal_map.uv_map = uv_layout.FINAL_UV_LAYER
        tree.links.new(normal_image_node.outputs["Color"], normal_map.inputs["Color"])
        tree.links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
    if color_node is not None:
        # Workbench previews show the active image node.
        tree.nodes.active = color_node

    for obj in mesh_tools.mesh_objects(target_objects):
        obj.data.materials.clear()
        obj.data.materials.append(material)
    leftover = bpy.data.materials.get(BAKE_MATERIAL_NAME)
    if leftover is not None and leftover.users == 0:
        bpy.data.materials.remove(leftover)
    return material


def _image_node(tree, path: str, is_color: bool, location: tuple):
    """Adds an image texture node for a saved texture file."""
    node = tree.nodes.new("ShaderNodeTexImage")
    node.image = bpy.data.images.load(path, check_existing=False)
    node.image.colorspace_settings.name = "sRGB" if is_color else "Non-Color"
    node.location = location
    return node
