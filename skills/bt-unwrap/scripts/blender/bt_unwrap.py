"""
bt-unwrap — clean up an AI-generated (or any) 3D model and give it a production texture:

    import -> orient / scale / origin -> repair geometry -> decimate to a face budget -> new UV layout ->
    bake the source textures onto it -> paint sharp reference views onto it -> one PBR material ->
    export (+ LODs) -> before / after previews, UV maps, alignment overlays and a JSON report.

Run inside Blender (the bt-unwrap.mjs launcher does this for you):

    blender --background --factory-startup --python-exit-code 1 --python bt_unwrap.py -- <input> [options]
"""
import argparse
import json
import os
import sys
import time
import traceback

SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import image_utils  # noqa: E402
import mesh_tools  # noqa: E402
import model_io  # noqa: E402
import previews  # noqa: E402
import reference_views  # noqa: E402
import texture_bake  # noqa: E402
import reference_warp  # noqa: E402
import texture_compose  # noqa: E402
import uv_layout  # noqa: E402

AUTO_MERGE_DISTANCE_FRACTION = 1e-5
DEFAULT_OUTPUT_FORMAT = "glb"
# Island padding scales with the texture: 8 px at 4096 keeps mip levels clean, 2 px is plenty at 1024.
PADDING_TEXTURE_DIVISOR = 512
MINIMUM_PADDING = 2
# Textures are built at twice the output size (up to this) and filtered down, for crisper edges and text.
SUPERSAMPLE_FACTOR = 2
MAXIMUM_AUTO_WORK_SIZE = 4096


def build_parser() -> argparse.ArgumentParser:
    """Every bt-unwrap option, grouped the way SKILL.md documents them."""
    parser = argparse.ArgumentParser(prog="bt-unwrap", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", help="model to process: .glb .gltf .fbx .obj .usd/.usda/.usdc/.usdz .ply .stl .abc .blend")

    output = parser.add_argument_group("output")
    output.add_argument("--output", help="output model file; its extension picks the format (.glb .gltf .fbx .obj .usd* .blend)")
    output.add_argument("--out-dir", help="folder for every output (default: <input folder>/<input name>_unwrap)")
    output.add_argument("--format", choices=["glb", "gltf", "fbx", "obj", "usd", "usdz", "blend"], default=None,
                        help="output format when --output is not given (default glb)")
    output.add_argument("--lods", default="", help="extra LOD files as triangle ratios, e.g. 0.5,0.25")
    output.add_argument("--no-preview", action="store_true", help="skip before/after renders and overlays")
    output.add_argument("--preview-size", type=int, default=1024, help="preview render size in pixels")
    output.add_argument("--analyze", action="store_true",
                        help="only check orientation and reference alignment; write overlays and the report, no model")

    cleanup = parser.add_argument_group("geometry cleanup")
    cleanup.add_argument("--merge-distance", type=float, default=None,
                         help="merge vertices closer than this, in meters (default: 0.001%% of the model diagonal)")
    cleanup.add_argument("--debris-faces", type=int, default=8,
                         help="delete loose parts with fewer faces than this (0 keeps all)")
    cleanup.add_argument("--fill-holes", type=int, default=0, help="fill open holes with up to N edges (0 = off)")
    cleanup.add_argument("--no-fix-normals", action="store_true", help="keep the original face winding")
    cleanup.add_argument("--faces", type=int, default=0, help="decimate to about this many triangles (0 = keep)")
    cleanup.add_argument("--shading", choices=["auto", "smooth", "flat", "keep"], default="auto",
                         help="auto = smooth with hard edges above --smooth-angle")
    cleanup.add_argument("--smooth-angle", type=float, default=30.0, help="hard-edge angle for --shading auto, degrees")
    cleanup.add_argument("--keep-objects", action="store_true",
                         help="keep separate objects and their pivots instead of joining into one mesh")

    placement = parser.add_argument_group("orientation and size")
    placement.add_argument("--forward", choices=["auto", "keep", "+x", "-x", "+y", "-y"], default="auto",
                           help="which Blender axis the model's front faces after import; auto detects it from the references")
    placement.add_argument("--rotate", default=None, help="extra rotation applied first, 'x,y,z' degrees")
    placement.add_argument("--length", type=float, default=0.0, help="scale so front-to-back size is this many meters")
    placement.add_argument("--width", type=float, default=0.0, help="scale so side-to-side size is this many meters")
    placement.add_argument("--height", type=float, default=0.0, help="scale so the height is this many meters")
    placement.add_argument("--origin", choices=["bottom", "center", "keep"], default="bottom",
                           help="bottom = center of the footprint at floor level")

    layout = parser.add_argument_group("UV layout")
    layout.add_argument("--unwrap", choices=["views", "smart", "keep"], default="views",
                        help="views = lay faces out from the front/rear/left/right/top/bottom they face; "
                             "smart = Blender Smart UV Project (organic shapes); keep = keep the existing UVs")
    layout.add_argument("--projections", type=int, choices=[6, 10, 14], default=6,
                        help="views used by --unwrap views: 6 box, 10 + horizontal diagonals, 14 + corners")
    layout.add_argument("--label-smoothing", type=int, default=6, help="passes that merge noisy face groups")
    layout.add_argument("--min-island-faces", type=int, default=24, help="islands smaller than this join a neighbour")
    layout.add_argument("--max-facing-angle", type=float, default=65.0,
                        help="a face may join a view only within this angle of facing it, degrees")
    layout.add_argument("--view-density", default="",
                        help="texture-space boost per view, e.g. left=1.5,right=1.5 for livery panels")
    layout.add_argument("--smart-angle", type=float, default=66.0, help="angle limit for --unwrap smart, degrees")
    layout.add_argument("--pack-rotate", choices=["none", "cardinal", "any"], default="any",
                        help="island rotation while packing: any = tightest (default), cardinal = 90-degree steps, "
                             "none = every island upright, for painting by hand")
    layout.add_argument("--padding", type=int, default=None,
                        help="pixels between islands and of edge padding (default: texture size / 512, at least 2)")
    layout.add_argument("--no-fix-overlaps", action="store_true", help="do not re-unwrap folded islands")
    layout.add_argument("--hidden-density", type=float, default=0.4,
                        help="texel density of surfaces no outside view can see, relative to visible ones; the "
                             "texture space saved goes to visible surfaces (1 = uniform density)")

    texture = parser.add_argument_group("texture")
    texture.add_argument("--texture-size", type=int, default=2048,
                         help="square output texture size in pixels (2048 suits game assets; 4096 for hero close-ups)")
    texture.add_argument("--work-size", type=int, default=0,
                         help="size the textures are built at before filtering down to --texture-size "
                              "(default: twice the output, up to 4096)")
    texture.add_argument("--refs", default=None,
                         help="folder of reference images (views found by file name; three-quarter views included)")
    texture.add_argument("--ref", action="append", default=[], metavar="VIEW=PATH",
                         help="one reference image: front, rear, left, right, top, bottom, an angled view such as "
                              "front_left or top_rear, or oblique for an angle to be found (repeatable)")
    texture.add_argument("--no-oblique", action="store_true",
                         help="use straight views only; skip three-quarter / angled reference images")
    texture.add_argument("--ref-rotate", action="append", default=[], metavar="VIEW=DEGREES",
                         help="fixed in-plane rotation of a reference (multiples of 90); top/bottom are detected otherwise")
    texture.add_argument("--ref-bg-tolerance", type=float, default=0.08,
                         help="how far a pixel may differ from the background color and still be background, 0..1")
    texture.add_argument("--ref-min-iou", type=float, default=0.80,
                         help="skip references whose silhouette matches the model worse than this, 0..1")
    texture.add_argument("--ref-align", choices=["fit", "refine"], default="refine",
                         help="refine = also search small scale/offset corrections for each reference")
    texture.add_argument("--ref-max-angle", type=float, default=70.0,
                         help="surfaces turned further than this from a view get nothing from it, degrees")
    texture.add_argument("--ref-source-score", type=float, default=0.35,
                         help="score (0..1: how head-on x how much of the face it sees x how well it agrees) a view "
                              "must beat to replace the model's own texture on a face; higher keeps more of it")
    texture.add_argument("--ref-seam-smoothness", type=float, default=0.12,
                         help="how strongly neighbouring faces join the same view; higher = larger patches, "
                              "fewer seams; 0 = every face for itself")
    texture.add_argument("--no-exposure-match", action="store_true",
                         help="do not even out the lighting baked into each reference (per-view gains from overlaps)")
    texture.add_argument("--no-ref-warp", action="store_true",
                         help="skip local alignment of references to the source texture (global fit only)")
    texture.add_argument("--ref-warp-max", type=float, default=0.04,
                         help="largest local shift a reference may get, as a fraction of its subject size")
    texture.add_argument("--ref-consistency", type=float, default=0.5,
                         help="0..1 how closely a reference's features must line up with the model's own texture "
                              "where that texture shows any; higher = stricter, 0 = trust references everywhere")
    texture.add_argument("--ref-normal-smoothing", type=int, default=8,
                         help="edge rings of normal smoothing used to weigh views, so lumpy panels paint evenly")
    texture.add_argument("--ref-strength", type=float, default=1.0, help="0..1 overall reference opacity")
    texture.add_argument("--ref-edge-inset", type=int, default=3, help="ignore this many pixels at the subject's edge")
    texture.add_argument("--depth-tolerance", type=float, default=0.01,
                         help="visibility test slack as a fraction of the model diagonal")
    texture.add_argument("--no-color-match", action="store_true",
                         help="do not match the source texture's colors to the references")
    texture.add_argument("--maps", default="auto", help="maps to produce: auto, or a list of color,metallic_roughness,normal")
    texture.add_argument("--roughness", type=float, default=None, help="constant roughness instead of a map")
    texture.add_argument("--metallic", type=float, default=None, help="constant metallic instead of a map")
    texture.add_argument("--no-normal-map", action="store_true", help="never produce a normal map")
    texture.add_argument("--keep-source-normal-map", action="store_true",
                         help="carry the source's own normal map over (off: generated normal maps are mostly relief "
                              "guessed from their texture, e.g. embossed logos, and fight the repainted texture)")
    texture.add_argument("--bake-distance", type=float, default=0.004,
                         help="bake ray search distance as a fraction of the model diagonal")
    texture.add_argument("--bake-samples", type=int, default=4, help="Cycles anti-aliasing samples per texel")
    texture.add_argument("--device", choices=["auto", "cpu", "gpu"], default="auto", help="Cycles bake device")
    texture.add_argument("--image-format", choices=["png", "jpeg", "webp"], default="webp",
                         help="how glTF / GLB stores its textures (webp = small downloads via EXT_texture_webp; "
                              "png = lossless); the files in textures/ are always lossless PNG masters")
    texture.add_argument("--image-quality", type=int, default=90, help="JPEG / WebP quality 0..100")
    texture.add_argument("--double-sided", action="store_true",
                         help="render both sides of every face (only for open, single-sheet surfaces; costs fill rate)")
    texture.add_argument("--draco", action="store_true",
                         help="Draco-compress the glTF / GLB geometry (smaller download; needs the Draco decoder "
                              "at load time)")
    return parser


def parse_options(argv: list) -> argparse.Namespace:
    """
    Parses and normalises the options after Blender's `--` separator.

    :param argv: Arguments for bt-unwrap only.
    :returns: The options namespace, with derived fields (view_density dict, ref_pairs, lod_ratios, paths).
    :raises SystemExit: on invalid input (argparse prints the reason).
    """
    parser = build_parser()
    options = parser.parse_args(argv)
    options.input = os.path.abspath(options.input)
    stem = os.path.splitext(os.path.basename(options.input))[0]
    options.stem = stem
    if options.output:
        options.output = os.path.abspath(options.output)
        options.out_dir = os.path.abspath(options.out_dir or os.path.dirname(options.output))
    else:
        options.out_dir = os.path.abspath(options.out_dir or os.path.join(os.path.dirname(options.input), f"{stem}_unwrap"))
        options.output = os.path.join(options.out_dir, f"{stem}.{options.format or DEFAULT_OUTPUT_FORMAT}")
    if _same_path(options.output, options.input):
        parser.error("the output would overwrite the input model; choose another --output or --out-dir "
                     "(bt-unwrap never replaces its source)")
    options.view_density = _parse_pairs(parser, options.view_density, "--view-density", float)
    options.ref_pairs = [_parse_reference_entry(parser, entry) for entry in options.ref]
    rotations = _parse_pairs(parser, ",".join(options.ref_rotate), "--ref-rotate", float)
    options.ref_quarter_turns = {view: int(round(degrees / 90.0)) % 4 for view, degrees in rotations.items()}
    options.refs = os.path.abspath(options.refs) if options.refs else None
    options.lod_ratios = [float(value) for value in options.lods.split(",") if value.strip()]
    if any(not 0.0 < ratio < 1.0 for ratio in options.lod_ratios):
        parser.error("--lods ratios must be between 0 and 1, e.g. 0.5,0.25")
    options.fix_normals = not options.no_fix_normals
    options.fix_overlaps = not options.no_fix_overlaps
    options.color_match = not options.no_color_match
    options.exposure_match = not options.no_exposure_match
    if options.texture_size < 64:
        parser.error("--texture-size must be at least 64")
    if options.padding is None:
        options.padding = max(MINIMUM_PADDING, options.texture_size // PADDING_TEXTURE_DIVISOR)
    if options.work_size <= 0:
        options.work_size = max(options.texture_size,
                                min(options.texture_size * SUPERSAMPLE_FACTOR, MAXIMUM_AUTO_WORK_SIZE))
    if options.work_size < options.texture_size:
        parser.error("--work-size cannot be smaller than --texture-size")
    options.work_padding = int(round(options.padding * options.work_size / options.texture_size))
    return options


def _parse_reference_entry(parser, entry: str) -> tuple:
    """Parses one --ref VIEW=PATH entry (the path may itself contain '=' or ',')."""
    if "=" not in entry:
        parser.error(f"--ref expects VIEW=PATH, got '{entry}'")
    view, path = entry.split("=", 1)
    return view.strip().lower(), os.path.abspath(path.strip())


def _same_path(first: str, second: str) -> bool:
    """True when two paths name the same file (case-insensitive file systems and symlinks included)."""
    return os.path.normcase(os.path.realpath(first)) == os.path.normcase(os.path.realpath(second))


def _parse_pairs(parser, text: str, flag: str, convert) -> dict:
    """Parses 'name=value,name=value' option text."""
    pairs = {}
    for item in [part.strip() for part in text.split(",") if part.strip()]:
        if "=" not in item:
            parser.error(f"{flag} expects name=value, got '{item}'")
        name, value = item.split("=", 1)
        try:
            pairs[name.strip().lower()] = convert(value.strip())
        except ValueError:
            parser.error(f"{flag}: '{value}' is not a valid value for {name}")
    return pairs


class Run:
    """One bt-unwrap run: the options, the scene objects being worked on, and the report being built."""

    def __init__(self, options: argparse.Namespace):
        self.options = options
        self.report = {"input": options.input, "options": _serializable_options(options), "steps": {},
                       "warnings": [], "outputs": {}, "timings_seconds": {}}
        self.objects = []
        self.targets = []
        self.sources = []
        self.references = []
        self.before_renders = {}
        self.diagnostic_map_paths = {}
        self.decimated = False
        self.started = time.time()

    def step(self, name: str, function, *arguments):
        """Runs one pipeline step, timing it and printing progress."""
        print(f"bt-unwrap: {name} ...", flush=True)
        step_started = time.time()
        result = function(*arguments)
        self.report["timings_seconds"][name] = round(time.time() - step_started, 2)
        return result

    def warn(self, message: str) -> None:
        """Records a warning in the report and prints it."""
        self.report["warnings"].append(message)
        print(f"bt-unwrap: WARNING {message}", flush=True)

    # ----- pipeline -------------------------------------------------------------------------------------

    def execute(self) -> dict:
        """Runs the whole pipeline and returns the report."""
        options = self.options
        os.makedirs(options.out_dir, exist_ok=True)
        self.step("import", self.import_model)
        self.step("references", self.load_references)
        self.step("orientation", self.orient_and_scale)
        if not options.no_preview:
            self.step("preview before", self.render_before)
        if options.analyze:
            self.step("reference alignment", self.align_references)
            return self.finish()
        self.step("cleanup", self.cleanup)
        self.step("decimate", self.decimate)
        self.step("unwrap", self.unwrap)
        self.step("reference alignment", self.align_references)
        self.step("textures", self.build_textures)
        self.step("export", self.export)
        if not options.no_preview:
            self.step("preview after", self.render_after)
        return self.finish()

    def import_model(self) -> None:
        """Loads the input and records what it contains."""
        self.objects = model_io.import_model(self.options.input)
        meshes = mesh_tools.mesh_objects(self.objects)
        materials = {slot.material.name for obj in meshes for slot in obj.material_slots if slot.material}
        self.report["steps"]["import"] = {
            "objects": len(self.objects), "meshes": len(meshes),
            "triangles": mesh_tools.count_triangles(meshes), "materials": len(materials),
            "images": len([image for image in bpy.data.images if image.size[0] > 0]),
            "has_armature": any(obj.type == "ARMATURE" for obj in self.objects),
        }

    def load_references(self) -> None:
        """Finds and loads the reference views (none is fine: the source texture is used alone)."""
        sources, notes = reference_views.discover_references(self.options.refs, self.options.ref_pairs,
                                                             not self.options.no_oblique)
        for source in sources:
            reference = reference_views.load_reference(source, self.options.ref_bg_tolerance,
                                                       self.options.ref_quarter_turns.get(source.view))
            self.references.append(reference)
        self.report["steps"]["references"] = {"found": {source.view: source.path for source in sources},
                                              "notes": notes}

    def orient_and_scale(self) -> None:
        """Turns the model to face glTF +Z (Blender -Y), scales it to size and places its origin."""
        options = self.options
        meshes = mesh_tools.mesh_objects(self.objects)
        mesh_tools.transform_model(self.objects, mesh_tools.rotation_from_euler_degrees(options.rotate))

        forward = options.forward
        scores = None
        if forward == "auto":
            if any(not reference.oblique for reference in self.references):
                triangles = mesh_tools.collect_triangles(meshes)
                forward, scores = reference_views.detect_forward(self.references, triangles.positions)
            else:
                forward = "keep"
                print("bt-unwrap: no straight reference view to detect the heading from; keeping the imported "
                      "one (--forward +x/-x/+y/-y turns it)", flush=True)
        if forward != "keep":
            mesh_tools.transform_model(self.objects, mesh_tools.forward_rotation(forward))

        matrix, scale_factor = mesh_tools.scale_and_origin_matrix(meshes, options.length, options.width,
                                                                  options.height, options.origin)
        mesh_tools.transform_model(self.objects, matrix)
        bpy.context.view_layer.update()
        minimum, maximum = mesh_tools.model_bounds(meshes)
        self.report["steps"]["orientation"] = {
            "forward_axis_detected": forward, "heading_scores": scores, "scale_factor": round(scale_factor, 6),
            "size_meters": np.round(maximum - minimum, 4).tolist(), "origin": options.origin,
        }

    def render_before(self) -> None:
        """Renders the model as imported (already turned to the common heading)."""
        preview_dir = os.path.join(self.options.out_dir, "preview")
        self.before_renders = previews.render_views(self.objects, preview_dir, "before", self.options.preview_size)

    def cleanup(self) -> None:
        """
        Keeps an untouched copy of the model for baking, then joins (unless --keep-objects), repairs geometry
        and sets shading. The copy keeps the imported shading normals and materials exactly as authored, so the
        bake carries the original look onto the cleaned mesh.
        """
        options = self.options
        self.sources = [mesh_tools.detached_copy(obj, f"{obj.name}_BakeSource")
                        for obj in mesh_tools.mesh_objects(self.objects)]
        if not options.keep_objects:
            if self.report["steps"]["import"]["has_armature"]:
                self.warn("rigged model: objects are kept separate so the skinning survives (--keep-objects)")
                options.keep_objects = True
            else:
                self.objects = [mesh_tools.join_meshes(self.objects)]
        self.targets = mesh_tools.mesh_objects(self.objects)
        diagonal = self.model_diagonal()
        merge_distance = options.merge_distance if options.merge_distance is not None \
            else diagonal * AUTO_MERGE_DISTANCE_FRACTION
        results = [mesh_tools.cleanup_mesh(obj, merge_distance, options.debris_faces, options.fix_normals,
                                           options.fill_holes) for obj in self.targets]
        mesh_tools.apply_shading(self.targets, options.shading, options.smooth_angle)
        self.report["steps"]["cleanup"] = {"merge_distance": merge_distance, "per_object": results,
                                           "triangles": mesh_tools.count_triangles(self.targets)}

    def decimate(self) -> None:
        """Reduces the model to the face budget (the bake copy keeps the full detail)."""
        options = self.options
        before = mesh_tools.count_triangles(self.targets)
        if options.faces > 0 and before > options.faces:
            budget_share = options.faces / before
            for obj in self.targets:
                mesh_tools.decimate_to_triangles(obj, int(mesh_tools.count_triangles([obj]) * budget_share))
            self.decimated = True
        after = mesh_tools.count_triangles(self.targets)
        self.report["steps"]["decimate"] = {"triangles_before": before, "triangles_after": after,
                                            "decimated": self.decimated}

    def unwrap(self) -> None:
        """Creates the new UV layout."""
        method = self.options.unwrap
        if method == "views":
            statistics = uv_layout.unwrap_by_views(self.targets, self.options)
        elif method == "smart":
            statistics = uv_layout.unwrap_smart(self.targets, self.options)
        else:
            statistics = uv_layout.keep_existing_layout(self.targets)
        if statistics.get("overlap_percent", 0) > 0.5:
            self.warn(f"{statistics['overlap_percent']}% of the layout overlaps; try --projections 14 or --unwrap smart")
        self.report["steps"]["unwrap"] = statistics

    def align_references(self) -> None:
        """Fits every reference's camera to the final geometry and builds its visibility depth buffer."""
        meshes = self.targets or mesh_tools.mesh_objects(self.objects)
        triangles = mesh_tools.collect_triangles(meshes)
        proxies = reference_views.build_silhouette_proxies(triangles.positions)
        preview_dir = os.path.join(self.options.out_dir, "preview")
        for reference in self.references:
            reference_views.align_reference(reference, triangles.positions, self.options.ref_align == "refine",
                                            self.options.ref_min_iou, proxies)
        self.report["steps"]["references"]["notes"].extend(reference_views.settle_oblique_views(self.references))
        for reference in self.references:
            reference_views.build_depth_buffer(reference, triangles.positions)
            if not reference.used:
                self.warn(f"{reference.view} reference not used: {reference.note}")
            if not self.options.no_preview:
                reference.overlay = previews.alignment_overlay(reference, preview_dir)
        self.report["steps"]["references"]["alignment"] = [reference.report() for reference in self.references]

    def build_textures(self) -> None:
        """Bakes the source maps onto the new layout, paints the references on, and saves the textures."""
        options = self.options
        texture_bake.ensure_source_materials(self.sources)
        source_summary = texture_bake.describe_source_materials(self.sources)
        constant_color = texture_bake.source_base_color(self.sources)
        maps = self.choose_maps(source_summary)
        size = options.work_size
        diagonal = self.model_diagonal()
        device = "none"
        baked = {}
        if maps:
            device = texture_bake.configure_cycles(options.bake_samples, options.device != "cpu")
            print(f"bt-unwrap: baking {', '.join(maps)} at {size}px on {device}", flush=True)
            baked = texture_bake.bake_source_maps(self.targets, self.sources, size, diagonal * options.bake_distance,
                                                  options.work_padding, tuple(maps), options.keep_source_normal_map)
        else:
            print("bt-unwrap: the source has no color data and there are no references: the material keeps its "
                  "constant color; the new layout is ready for painting", flush=True)
        for source in self.sources:
            bpy.data.objects.remove(source, do_unlink=True)
        self.sources = []

        triangles = mesh_tools.collect_triangles(self.targets, (uv_layout.NEW_UV_LAYER,))
        vertex_normals = mesh_tools.smoothed_vertex_normals(self.targets, options.ref_normal_smoothing)
        surface = texture_compose.build_texel_surface(triangles, size, vertex_normals)
        texture_dir = os.path.join(options.out_dir, "textures")
        texture_paths = {}
        compose_statistics = {}
        output_size = options.texture_size
        color = baked.get("color")
        if color is not None:
            self.match_references(triangles, color)
            color, compose_statistics, diagnostic_maps = texture_compose.compose_color(
                color, surface, triangles, self.references, options, diagonal, options.work_padding)
            color = image_utils.downsample_map(color, output_size)
            if not options.no_preview:
                for name, diagnostic_map in diagnostic_maps.items():
                    self.diagnostic_map_paths[name] = image_utils.save_image_array(
                        image_utils.downsample_map(diagnostic_map, output_size),
                        os.path.join(options.out_dir, "preview", f"{name}_texture.png"))
            # The texture files are lossless masters; the model file encodes them once, in --image-format.
            texture_paths["color"] = image_utils.save_image_array(
                color, os.path.join(texture_dir, f"{options.stem}_basecolor.png"))
        if "metallic_roughness" in baked:
            texture_paths["metallic_roughness"] = image_utils.save_image_array(
                image_utils.downsample_map(baked["metallic_roughness"], output_size),
                os.path.join(texture_dir, f"{options.stem}_metallic_roughness.png"))
        if "normal" in baked:
            texture_paths["normal"] = image_utils.save_image_array(
                image_utils.downsample_map(baked["normal"], output_size, is_normal_map=True),
                os.path.join(texture_dir, f"{options.stem}_normal.png"))

        uv_layout.finalize_uv_layers(self.targets)
        texture_bake.build_final_material(self.targets, f"{options.stem}_Material", texture_paths,
                                          options.roughness, options.metallic, constant_color, options.double_sided)
        layout_images = {}
        if not options.no_preview:
            layout_background = color if color is not None else \
                np.broadcast_to(np.array(constant_color, dtype=np.float32), (output_size, output_size, 4)).copy()
            covered = image_utils.downsample_map(surface.covered_mask().astype(np.float32), output_size) > 0.0
            layout_images = previews.uv_layout_images(layout_background, covered, texture_dir, options.stem)
        self.report["steps"]["textures"] = {"bake_device": device, "maps": maps, "source": source_summary,
                                            "output_size": output_size, "work_size": size,
                                            "compose": compose_statistics, "files": texture_paths,
                                            "uv_images": layout_images}

    def match_references(self, triangles, baked_color) -> None:
        """
        Locally aligns every used reference to the mesh by matching it against the baked source texture
        rendered from the same camera, then maps where each reference agrees with that texture (and so may
        paint). Writes a check image per view for both.
        """
        options = self.options
        preview_dir = os.path.join(options.out_dir, "preview")
        for reference in [reference for reference in self.references if reference.used]:
            if not options.no_ref_warp:
                reference.warp = reference_warp.estimate_warp(reference, triangles, baked_color, options.ref_warp_max)
                if reference.warp is None:
                    self.warn(f"{reference.view} reference: no detail to align locally; using the global fit only")
                if not options.no_preview:
                    check_image = reference_warp.warp_preview(reference, triangles, baked_color)
                    image_utils.save_image_array(check_image, os.path.join(preview_dir, f"warp_{reference.view}.png"))
            if options.ref_consistency > 0.0:
                reference.agreement = reference_warp.consistency_map(reference, triangles, baked_color,
                                                                     options.ref_consistency)
                if reference.agreement is not None and not options.no_preview:
                    image_utils.save_image_array(reference_warp.consistency_preview(reference.agreement),
                                                 os.path.join(preview_dir, f"consistency_{reference.view}.png"))
        self.report["steps"]["references"]["alignment"] = [reference.report() for reference in self.references]

    def choose_maps(self, source_summary: dict) -> list:
        """Decides which texture maps to bake from what the source has and what was asked for."""
        options = self.options
        if options.maps != "auto":
            maps = [name.strip() for name in options.maps.split(",") if name.strip()]
            unknown = set(maps) - {"color", "metallic_roughness", "normal"}
            if unknown:
                raise ValueError(f"--maps: unknown map(s) {', '.join(sorted(unknown))}")
        else:
            maps = []
            has_color_data = source_summary["has_color_texture"] or source_summary["has_vertex_colors"] or \
                any(reference.used for reference in self.references)
            if has_color_data:
                maps.append("color")
            if source_summary["has_metallic_roughness_texture"] and (options.roughness is None or options.metallic is None):
                maps.append("metallic_roughness")
            # A normal map earns its texture when it carries shape the mesh lost in decimation, or when the
            # source's own normal map is wanted; a generated one is otherwise guessed relief that fights the
            # repainted texture.
            if self.decimated or (source_summary["has_normal_map"] and options.keep_source_normal_map):
                maps.append("normal")
        if options.no_normal_map and "normal" in maps:
            maps.remove("normal")
        return maps

    def export(self) -> None:
        """Writes the model and its LODs."""
        options = self.options
        export_objects = [obj for obj in bpy.context.scene.objects if obj.type in ("MESH", "ARMATURE", "EMPTY")]
        main_path = model_io.export_model(options.output, export_objects, options.image_format, options.image_quality,
                                          options.draco, self.has_normal_map())
        outputs = {"model": main_path, "lods": []}
        for level, ratio in enumerate(options.lod_ratios, start=1):
            outputs["lods"].append(self.export_lod(level, ratio, export_objects))
        self.report["outputs"].update(outputs)
        self.report["steps"]["export"] = {"triangles": mesh_tools.count_triangles(self.targets),
                                          "file_megabytes": round(os.path.getsize(main_path) / 1e6, 2)}

    def export_lod(self, level: int, ratio: float, export_objects: list) -> dict:
        """Exports one decimated copy that shares the main model's UVs and textures."""
        base, extension = os.path.splitext(self.options.output)
        copies = [mesh_tools.duplicate_object(obj, f"{obj.name}_LOD{level}") for obj in self.targets]
        for copy in copies:
            mesh_tools.decimate_to_triangles(copy, int(mesh_tools.count_triangles([copy]) * ratio))
        others = [obj for obj in export_objects if obj.type != "MESH"]
        path = model_io.export_model(f"{base}_lod{level}{extension}", copies + others, self.options.image_format,
                                     self.options.image_quality, self.options.draco, self.has_normal_map())
        triangles = mesh_tools.count_triangles(copies)
        for copy in copies:
            bpy.data.objects.remove(copy, do_unlink=True)
        return {"path": path, "ratio": ratio, "triangles": triangles}

    def render_after(self) -> None:
        """Renders the result and writes the before/after comparison sheet."""
        preview_dir = os.path.join(self.options.out_dir, "preview")
        after = previews.render_views(self.targets, preview_dir, "after", self.options.preview_size)
        for name, texture_path in self.diagnostic_map_paths.items():
            self.report["outputs"][f"{name}_renders"] = previews.render_with_texture(
                self.targets, texture_path, preview_dir, name, self.options.preview_size)
        sheet = previews.comparison_sheet(self.before_renders, after, os.path.join(preview_dir, "comparison.png"))
        self.report["outputs"]["previews"] = {"before": self.before_renders, "after": after, "comparison": sheet}

    # ----- helpers --------------------------------------------------------------------------------------

    def has_normal_map(self) -> bool:
        """True when the final material carries a baked normal map."""
        return "normal" in self.report["steps"].get("textures", {}).get("files", {})

    def model_diagonal(self) -> float:
        """Length of the model's bounding-box diagonal in meters."""
        meshes = self.targets or mesh_tools.mesh_objects(self.objects)
        minimum, maximum = mesh_tools.model_bounds(meshes)
        return float(np.linalg.norm(maximum - minimum))

    def finish(self) -> dict:
        """Writes the JSON report and returns it."""
        self.report["timings_seconds"]["total"] = round(time.time() - self.started, 2)
        overlays = [reference.overlay for reference in self.references if reference.overlay]
        if overlays:
            self.report["outputs"]["alignment_overlays"] = overlays
        report_path = os.path.join(self.options.out_dir, f"{self.options.stem}_report.json")
        self.report["outputs"]["report"] = report_path
        with open(report_path, "w", encoding="utf-8") as report_file:
            json.dump(self.report, report_file, indent=2, default=_json_default)
        return self.report


def _serializable_options(options: argparse.Namespace) -> dict:
    """The options as plain JSON values."""
    return {name: value for name, value in vars(options).items() if isinstance(value, (str, int, float, bool, list, dict, type(None)))}


def _json_default(value):
    """Converts numpy scalars for json.dump."""
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    return str(value)


def print_summary(report: dict) -> None:
    """Prints the headline numbers a person (or agent) needs after a run."""
    steps = report["steps"]
    lines = [f"input      {report['input']}"]
    if "import" in steps:
        lines.append(f"triangles  {steps['import']['triangles']:,} in -> "
                     f"{steps.get('export', {}).get('triangles', steps['import']['triangles']):,} out")
    if "orientation" in steps:
        lines.append(f"forward    {steps['orientation']['forward_axis_detected']}  size {steps['orientation']['size_meters']} m")
    if "unwrap" in steps:
        unwrap = steps["unwrap"]
        lines.append(f"layout     {unwrap['method']}: {unwrap['islands']} islands, {unwrap['uv_coverage_percent']}% of the "
                     f"texture used, {unwrap['overlap_percent']}% overlap")
    for alignment in steps.get("references", {}).get("alignment", []):
        state = "used" if alignment["used"] else "SKIPPED"
        lines.append(f"reference  {alignment['view']:<6} iou {alignment['silhouette_iou']:.3f} {state}  {alignment['path']}")
    if "textures" in steps:
        compose = steps["textures"]["compose"]
        lines.append(f"textures   {', '.join(steps['textures']['maps']) or 'none (constant color)'}; "
                     f"{compose.get('reference_painted_percent', 0.0)}% of the "
                     f"surface painted from references")
    for name, path in report["outputs"].items():
        if isinstance(path, str):
            lines.append(f"{name:<10} {path}")
    for lod in report["outputs"].get("lods", []):
        lines.append(f"lod        {lod['triangles']:,} triangles  {lod['path']}")
    if report["outputs"].get("previews", {}).get("comparison"):
        lines.append(f"compare    {report['outputs']['previews']['comparison']}")
    for warning in report["warnings"]:
        lines.append(f"warning    {warning}")
    print("\n".join(f"bt-unwrap: {line}" for line in lines), flush=True)


def main() -> int:
    """Entry point: parse options after `--`, run, print the summary. Returns the process exit code."""
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    options = parse_options(argv)
    try:
        report = Run(options).execute()
    except (RuntimeError, ValueError) as error:
        # Expected failures (bad input, a model the chosen options cannot handle) get a one-line reason;
        # anything else is a bug and keeps Blender's full traceback.
        if os.environ.get("BT_UNWRAP_TRACEBACK"):
            traceback.print_exc()
        print(f"bt-unwrap: FAILED {error}", flush=True)
        return 1
    print_summary(report)
    print("bt-unwrap: DONE", flush=True)
    return 0


if __name__ == "__main__":
    exit_code = main()
    if exit_code:
        sys.exit(exit_code)
