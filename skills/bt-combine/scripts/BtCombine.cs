using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

/// <summary>
/// bt-combine engine. Decides which static meshes and LOD groups of the active scene can be merged without changing
/// how the scene looks in Unity or in BabylonJS, writes the reasoning to _combine/&lt;scene&gt;/, and merges them with the
/// Babylon Toolkit's MeshCombiner (Pack Source Lightmap UVs mode, so no vertex is split).
/// Run every entry point with `unity command run_script --file &lt;this file&gt; --entry BtCombine.&lt;Method&gt;`.
/// </summary>
public static class BtCombine
{
    /// <summary>Name prefix of merged static meshes; the planner never merges these again.</summary>
    private const string StaticPrefix = "Combined_";

    /// <summary>Name prefix of merged LOD clusters.</summary>
    private const string LodPrefix = "CombinedLOD_";

    /// <summary>First of the toolkit's reserved export layers (Hidden, No Instance, Ignore Export, Prefab).</summary>
    private const int FirstReservedLayer = 28;

    /// <summary>Render queues from here up are transparent: they are sorted per mesh, so merging changes draw order.</summary>
    private const int FirstTransparentQueue = 2500;

    /// <summary>Largest vertex count one merged mesh may reach; bigger meshes cull badly and upload slowly.</summary>
    private const int MaxVerticesPerMesh = 200000;

    /// <summary>A merged mesh may grow at most this much over the sum of its sources before the run is flagged as bloated.</summary>
    private const float VertexBloatTolerance = 1.02f;

    /// <summary>Largest share of the LOD0 → LOD1 switch distance a cluster member may sit from the cluster centre.</summary>
    private const float MaxLodSwitchError = 0.2f;

    /// <summary>A rescaled LOD0 transition height must stay below this, or the cluster is too big to switch like its members.</summary>
    private const float MaxRescaledTransition = 0.95f;

    /// <summary>Built-in shaders whose look does not depend on the object's pivot or object space.</summary>
    private static readonly string[] SafeShaders =
    {
        "Universal Render Pipeline/Lit", "Universal Render Pipeline/Simple Lit", "Universal Render Pipeline/Complex Lit",
        "Universal Render Pipeline/Baked Lit", "Universal Render Pipeline/Unlit",
        "Standard", "Standard (Specular setup)", "Autodesk Interactive", "HDRP/Lit", "HDRP/Unlit",
    };

    /// <summary>Settings for a run. Every field has a safe default; the skill passes overrides as JSON.</summary>
    [Serializable]
    public class Options
    {
        /// <summary>Edge of the square area cell ("patch"), in meters, that keeps merged meshes local.</summary>
        public float cellSize = 15f;
        /// <summary>How far, in meters, a merged group's footprint may extend past its largest piece.</summary>
        public float maxSpread = 3f;
        /// <summary>Largest share of one lightmap atlas a merged lightmapped mesh may fill.</summary>
        public float maxAtlasShare = 0.45f;
        /// <summary>Also merge Shader Graph materials that pass the object-space / vertex-animation scan.</summary>
        public bool includeShaderGraphs = false;
        /// <summary>Merge LOD groups into LOD clusters.</summary>
        public bool combineLods = true;
        /// <summary>Names (or name prefixes ending in *) of objects whose subtrees are never merged.</summary>
        public string[] exclude = new string[0];
        /// <summary>When set, only renderers under these hierarchy paths are considered.</summary>
        public string[] only = new string[0];
        /// <summary>Extra shader names to treat as safe.</summary>
        public string[] extraShaders = new string[0];
        /// <summary>Proceed on a toolkit without Pack Source Lightmap UVs (re-unwraps and bloats vertices).</summary>
        public bool allowUnityUnwrap = false;
    }

    /// <summary>One planned (Analyze) or performed (Apply) merge.</summary>
    public class GroupRecord
    {
        public string name;
        public string kind;
        public string container;
        public string probe;
        public bool lightmapped;
        public int lodLevels;
        public int vertices;
        public int drawsBefore;
        public int drawsAfter;
        public int lights;
        public float atlasShare;
        public float densityBefore;
        public float spreadMeters;
        public float sizeRatio;
        public string[] sources = new string[0];
        public string combinedPath = "";
        public string[] meshAssets = new string[0];
        public int combinedVertices;
    }

    /// <summary>The whole analysis or manifest.</summary>
    public class RunRecord
    {
        public string scene;
        public string mode;
        public int renderersBefore;
        public int drawsBefore;
        public int renderersAfter;
        public int drawsAfter;
        public List<GroupRecord> groups = new List<GroupRecord>();
        public List<string> advisories = new List<string>();
        public List<string> warnings = new List<string>();

        /// <summary>Writes the record as JSON (flat arrays: JsonUtility drops lists of custom classes from run_script assemblies).</summary>
        public string ToJson()
        {
            var file = new RunFile
            {
                scene = scene, mode = mode, renderersBefore = renderersBefore, drawsBefore = drawsBefore,
                renderersAfter = renderersAfter, drawsAfter = drawsAfter, advisories = advisories.ToArray(), warnings = warnings.ToArray(),
                names = groups.Select(g => g.name).ToArray(), kinds = groups.Select(g => g.kind).ToArray(),
                containers = groups.Select(g => g.container).ToArray(), probes = groups.Select(g => g.probe).ToArray(),
                lightmapped = groups.Select(g => g.lightmapped).ToArray(), lodLevels = groups.Select(g => g.lodLevels).ToArray(),
                vertices = groups.Select(g => g.vertices).ToArray(), groupDrawsBefore = groups.Select(g => g.drawsBefore).ToArray(),
                groupDrawsAfter = groups.Select(g => g.drawsAfter).ToArray(), lights = groups.Select(g => g.lights).ToArray(),
                atlasShare = groups.Select(g => g.atlasShare).ToArray(), densityBefore = groups.Select(g => g.densityBefore).ToArray(),
                spreadMeters = groups.Select(g => g.spreadMeters).ToArray(), sizeRatio = groups.Select(g => g.sizeRatio).ToArray(),
                sources = groups.Select(g => string.Join(SourceSeparator, g.sources)).ToArray(), combinedPaths = groups.Select(g => g.combinedPath).ToArray(),
                meshAssets = groups.Select(g => string.Join(SourceSeparator, g.meshAssets)).ToArray(), combinedVertices = groups.Select(g => g.combinedVertices).ToArray(),
            };
            return JsonUtility.ToJson(file, true);
        }

        /// <summary>Reads a record written by ToJson.</summary>
        public static RunRecord FromJson(string json)
        {
            var file = JsonUtility.FromJson<RunFile>(json);
            var record = new RunRecord
            {
                scene = file.scene, mode = file.mode, renderersBefore = file.renderersBefore, drawsBefore = file.drawsBefore,
                renderersAfter = file.renderersAfter, drawsAfter = file.drawsAfter,
                advisories = file.advisories.ToList(), warnings = file.warnings.ToList(),
            };
            for (int i = 0; i < file.names.Length; i++)
            {
                record.groups.Add(new GroupRecord
                {
                    name = file.names[i], kind = file.kinds[i], container = file.containers[i], probe = file.probes[i], lightmapped = file.lightmapped[i],
                    lodLevels = file.lodLevels[i], vertices = file.vertices[i], drawsBefore = file.groupDrawsBefore[i], drawsAfter = file.groupDrawsAfter[i],
                    lights = file.lights[i], atlasShare = file.atlasShare[i], densityBefore = file.densityBefore[i], spreadMeters = file.spreadMeters[i],
                    sizeRatio = file.sizeRatio[i], sources = file.sources[i].Split(new[] { SourceSeparator }, StringSplitOptions.RemoveEmptyEntries),
                    combinedPath = file.combinedPaths[i], meshAssets = file.meshAssets[i].Split(new[] { SourceSeparator }, StringSplitOptions.RemoveEmptyEntries),
                    combinedVertices = file.combinedVertices[i],
                });
            }
            return record;
        }
    }

    /// <summary>Separator for lists stored inside one JSON string.</summary>
    private const string SourceSeparator = " ;; ";

    /// <summary>On-disk form of a RunRecord: one array per group field (index i across arrays = group i).</summary>
    [Serializable]
    public class RunFile
    {
        public string scene;
        public string mode;
        public int renderersBefore;
        public int drawsBefore;
        public int renderersAfter;
        public int drawsAfter;
        public string[] advisories = new string[0];
        public string[] warnings = new string[0];
        public string[] names = new string[0];
        public string[] kinds = new string[0];
        public string[] containers = new string[0];
        public string[] probes = new string[0];
        public bool[] lightmapped = new bool[0];
        public int[] lodLevels = new int[0];
        public int[] vertices = new int[0];
        public int[] groupDrawsBefore = new int[0];
        public int[] groupDrawsAfter = new int[0];
        public int[] lights = new int[0];
        public float[] atlasShare = new float[0];
        public float[] densityBefore = new float[0];
        public float[] spreadMeters = new float[0];
        public float[] sizeRatio = new float[0];
        public string[] sources = new string[0];
        public string[] combinedPaths = new string[0];
        public string[] meshAssets = new string[0];
        public int[] combinedVertices = new int[0];
    }

    // ------------------------------------------------------------------------------------------------ entry points

    /// <summary>
    /// Read-only readiness check: Editor state, toolkit packing support, scene save state and lighting state.
    /// </summary>
    public static string Preflight(string sourceScene)
    {
        var report = new StringBuilder();
        report.AppendLine("unity=" + Application.unityVersion);
        report.AppendLine("playMode=" + EditorApplication.isPlayingOrWillChangePlaymode);
        report.AppendLine("packSourceLightmapUVs=" + ToolkitPacksSourceUVs());
        report.AppendLine("sourceExists=" + File.Exists(sourceScene));
        var active = SceneManager.GetActiveScene();
        report.AppendLine("activeScene=" + active.path + " dirty=" + active.isDirty);
        report.AppendLine("maxLightsPerMesh=" + MaxLightsPerMesh());
        return report.ToString();
    }

    /// <summary>
    /// Makes (or with reset, re-makes) the working copy of the source scene and opens it. The source is never edited.
    /// A reset copies the file over the existing copy so its GUID survives, and deletes the previous merged meshes.
    /// </summary>
    public static string PrepareCopy(string sourceScene, string outputScene, bool reset)
    {
        ThrowIfAnySceneDirty();
        if (sourceScene == outputScene) throw new InvalidOperationException("The output scene must differ from the source (use --in-place handling in the skill).");
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        bool existed = File.Exists(outputScene);
        if (!existed)
        {
            if (!AssetDatabase.CopyAsset(sourceScene, outputScene)) throw new InvalidOperationException("Could not copy " + sourceScene + " to " + outputScene);
        }
        else if (reset)
        {
            File.Copy(sourceScene, outputScene, true);
            AssetDatabase.ImportAsset(outputScene, ImportAssetOptions.ForceUpdate);
            string meshFolder = MeshFolderFor(outputScene);
            if (AssetDatabase.IsValidFolder(meshFolder)) AssetDatabase.DeleteAsset(meshFolder);
            string manifest = Path.Combine(ReportFolderFor(outputScene), "manifest.json");
            if (File.Exists(manifest)) File.Delete(manifest);
        }
        var scene = EditorSceneManager.OpenScene(outputScene, OpenSceneMode.Single);
        Directory.CreateDirectory(ReportFolderFor(outputScene));
        File.WriteAllText(WorkingCopyMarker(outputScene), sourceScene);
        return "opened=" + scene.path + " created=" + !existed + " reset=" + (existed && reset);
    }

    /// <summary>Deletes a working copy, its merged meshes, its baked lighting folder and its report folder.</summary>
    public static string RemoveCopy(string outputScene, string reopenScene)
    {
        if (!File.Exists(WorkingCopyMarker(outputScene))) throw new InvalidOperationException(outputScene + " is not a bt-combine working copy; refusing to delete it.");
        ThrowIfAnySceneDirty();
        EditorSceneManager.OpenScene(reopenScene, OpenSceneMode.Single);
        bool sceneDeleted = AssetDatabase.DeleteAsset(outputScene);
        bool meshesDeleted = AssetDatabase.DeleteAsset(MeshFolderFor(outputScene));
        bool lightingDeleted = AssetDatabase.DeleteAsset(Path.ChangeExtension(outputScene, null).Replace('\\', '/'));
        string reportFolder = ReportFolderFor(outputScene);
        if (Directory.Exists(reportFolder)) Directory.Delete(reportFolder, true);
        return "sceneDeleted=" + sceneDeleted + " meshesDeleted=" + meshesDeleted + " lightingDeleted=" + lightingDeleted;
    }

    /// <summary>
    /// Plans the merges for the active scene without changing it, and writes analysis.md + analysis.json to
    /// _combine/&lt;scene&gt;/. Returns the Markdown report.
    /// </summary>
    public static string Analyze(string optionsJson)
    {
        var options = ParseOptions(optionsJson);
        var scene = SceneManager.GetActiveScene();
        var plan = BuildPlan(scene, options);
        var record = plan.ToRecord("analysis");
        string markdown = plan.ToMarkdown(record, options);
        string folder = ReportFolderFor(scene.path);
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, "analysis.md"), markdown);
        File.WriteAllText(Path.Combine(folder, "analysis.json"), record.ToJson());
        return markdown;
    }

    /// <summary>
    /// Plans and performs the merges on the active scene (which must be a bt-combine working copy), saves it, and
    /// writes manifest.json. Lighting must be re-baked afterwards when any lightmapped mesh was merged.
    /// </summary>
    public static string Apply(string optionsJson)
    {
        var options = ParseOptions(optionsJson);
        if (!ToolkitPacksSourceUVs() && !options.allowUnityUnwrap)
        {
            throw new InvalidOperationException("This Babylon Toolkit build has no Pack Source Lightmap UVs mode: its combiner re-unwraps merged meshes "
                + "and splits vertices (often +50%). Update CanvasTools.dll, or pass allowUnityUnwrap to accept the bloat.");
        }
        var scene = SceneManager.GetActiveScene();
        if (!File.Exists(WorkingCopyMarker(scene.path)))
        {
            throw new InvalidOperationException(scene.path + " is not a bt-combine working copy. Run PrepareCopy first; Apply never edits a source scene.");
        }
        string manifestPath = Path.Combine(ReportFolderFor(scene.path), "manifest.json");
        if (File.Exists(manifestPath) || HasCombinedObjects(scene))
        {
            throw new InvalidOperationException("This scene was already combined. Run with reset to start again from the source scene.");
        }

        var plan = BuildPlan(scene, options);
        var record = plan.ToRecord("manifest");
        string meshFolder = MeshFolderFor(scene.path);
        EnsureFolder(meshFolder);
        var usedNames = new HashSet<string>();
        foreach (var groupRecord in record.groups)
        {
            groupRecord.name = UniqueName(groupRecord.name, usedNames);
        }

        for (int i = 0; i < plan.StaticGroups.Count; i++)
        {
            CombineStaticGroup(plan.StaticGroups[i], record.groups[i], meshFolder, plan.Context, record);
        }
        for (int i = 0; i < plan.LodClusters.Count; i++)
        {
            CombineLodCluster(plan.LodClusters[i], record.groups[plan.StaticGroups.Count + i], meshFolder, plan.Context, record);
        }
        UnityMeshSimplifier.MeshCombiner.ClearUv2Cache();

        EditorSceneManager.MarkSceneDirty(scene);
        EditorSceneManager.SaveScene(scene);
        AssetDatabase.SaveAssets();
        CountScene(scene, out record.renderersAfter, out record.drawsAfter);
        Directory.CreateDirectory(ReportFolderFor(scene.path));
        File.WriteAllText(manifestPath, record.ToJson());

        var summary = new StringBuilder();
        summary.AppendLine("applied=" + scene.path + " groups=" + record.groups.Count + " renderers " + record.renderersBefore + " -> " + record.renderersAfter
            + " draws " + record.drawsBefore + " -> " + record.drawsAfter);
        summary.AppendLine("needsBake=" + record.groups.Any(g => g.lightmapped));
        foreach (var group in record.groups)
        {
            summary.AppendLine("  " + group.kind + " " + group.name + " sources=" + group.sources.Length + " verts " + group.vertices + " -> " + group.combinedVertices);
        }
        foreach (var warning in record.warnings) summary.AppendLine("  WARNING " + warning);
        return summary.ToString();
    }

    /// <summary>
    /// Post-bake checks on the active (combined) scene: every merged lightmapped mesh got a lightmap slot, its UV2 is
    /// inside 0..1, its texel density is close to its sources', LOD clusters are well formed, and the scene uses its
    /// own LightingData. Writes verify.md and returns it.
    /// </summary>
    public static string Verify()
    {
        var scene = SceneManager.GetActiveScene();
        string manifestPath = Path.Combine(ReportFolderFor(scene.path), "manifest.json");
        if (!File.Exists(manifestPath)) throw new InvalidOperationException("No manifest.json for " + scene.path + ". Run Apply first.");
        var manifest = RunRecord.FromJson(File.ReadAllText(manifestPath));
        var report = new StringBuilder("# bt-combine verify — " + scene.path + "\n\n");
        int problems = 0;

        string lightingData = Lightmapping.lightingDataAsset != null ? AssetDatabase.GetAssetPath(Lightmapping.lightingDataAsset) : "";
        string expectedLightingFolder = Path.ChangeExtension(scene.path, null).Replace('\\', '/') + "/";
        bool ownLighting = lightingData.StartsWith(expectedLightingFolder);
        bool anyLightmapped = manifest.groups.Any(g => g.lightmapped);
        report.AppendLine("- LightingData: `" + (lightingData == "" ? "none" : lightingData) + "` " + (ownLighting ? "(this scene's own bake)" : anyLightmapped ? "**NOT this scene's bake — re-bake**" : ""));
        if (anyLightmapped && !ownLighting) problems++;
        report.AppendLine("\n| Merged object | Check | Result |\n|---|---|---|");

        foreach (var group in manifest.groups)
        {
            var root = FindByPath(scene, group.combinedPath);
            if (root == null) { report.AppendLine("| " + group.name + " | exists | **missing** |"); problems++; continue; }
            var renderers = root.GetComponentsInChildren<MeshRenderer>();
            foreach (var renderer in renderers)
            {
                var mesh = renderer.GetComponent<MeshFilter>().sharedMesh;
                bool wantsLightmap = IsLightmapped(renderer);
                if (wantsLightmap)
                {
                    bool hasSlot = renderer.lightmapIndex >= 0 && renderer.lightmapIndex < 65534;
                    if (!hasSlot) problems++;
                    report.AppendLine("| " + renderer.name + " | lightmap slot | " + (hasSlot ? "index " + renderer.lightmapIndex : "**none — bake again**") + " |");
                    var uvs = new List<Vector2>();
                    mesh.GetUVs(1, uvs);
                    bool inRange = uvs.Count > 0 && uvs.All(uv => uv.x >= -0.0001f && uv.y >= -0.0001f && uv.x <= 1.0001f && uv.y <= 1.0001f);
                    if (!inRange) problems++;
                    report.AppendLine("| " + renderer.name + " | UV2 inside 0..1 | " + (inRange ? "yes" : "**no**") + " |");
                    if (hasSlot && group.densityBefore > 0f && renderer == renderers[0])
                    {
                        float density = TexelDensity(renderer);
                        bool close = density >= group.densityBefore * 0.8f;
                        if (!close) problems++;
                        report.AppendLine("| " + renderer.name + " | texels/m (sources " + group.densityBefore.ToString("0.0") + ") | " + density.ToString("0.0") + (close ? "" : " **too low**") + " |");
                    }
                }
            }
            var lodGroup = root.GetComponent<LODGroup>();
            if (lodGroup != null)
            {
                var lods = lodGroup.GetLODs();
                bool monotonic = true;
                for (int i = 1; i < lods.Length; i++) monotonic &= lods[i].screenRelativeTransitionHeight < lods[i - 1].screenRelativeTransitionHeight;
                bool onePerLevel = lods.All(lod => lod.renderers.Length == 1 && lod.renderers[0] != null);
                if (!monotonic || !onePerLevel) problems++;
                report.AppendLine("| " + root.name + " | LOD levels | " + lods.Length + " levels, transitions " + string.Join(" / ", lods.Select(l => l.screenRelativeTransitionHeight.ToString("0.###")))
                    + (monotonic && onePerLevel ? "" : " **malformed**") + " |");
            }
        }
        report.AppendLine("\nproblems=" + problems);
        File.WriteAllText(Path.Combine(ReportFolderFor(scene.path), "verify.md"), report.ToString());
        return report.ToString();
    }

    /// <summary>
    /// QA: lists the world positions of the largest merges in the active (combined) scene — LOD clusters first — as
    /// "name|x|y|z|size" lines, so the skill can point the camera at them in both scenes.
    /// </summary>
    public static string QaPoints(int count)
    {
        var scene = SceneManager.GetActiveScene();
        var manifest = RunRecord.FromJson(File.ReadAllText(Path.Combine(ReportFolderFor(scene.path), "manifest.json")));
        var lines = new StringBuilder();
        foreach (var group in manifest.groups.OrderByDescending(g => g.kind == "lod").ThenByDescending(g => g.sources.Length).Take(count))
        {
            var root = FindByPath(scene, group.combinedPath);
            if (root == null) continue;
            var bounds = MergedBounds(root.GetComponentsInChildren<Renderer>().Select(r => r.bounds));
            lines.AppendLine(group.name + "|" + bounds.center.x.ToString("F2") + "|" + bounds.center.y.ToString("F2") + "|" + bounds.center.z.ToString("F2") + "|" + Mathf.Max(bounds.size.x, bounds.size.y, bounds.size.z).ToString("F2"));
        }
        return lines.ToString();
    }

    /// <summary>
    /// QA: opens a scene, aims its main camera at a world point from the given distance (Cinemachine disabled so it
    /// stays put), and forces every LOD group to forceLod (-1 = normal switching). Nothing is saved; capture with
    /// capture_game_view --camera &lt;main camera&gt;, then reopen the working copy.
    /// </summary>
    public static string QaView(string scenePath, float x, float y, float z, float distance, int forceLod)
    {
        ThrowIfAnySceneDirty();
        var scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
        var mainCamera = Camera.main;
        if (mainCamera == null) throw new InvalidOperationException("The scene has no camera tagged MainCamera.");
        var brain = mainCamera.GetComponent("CinemachineBrain") as Behaviour;
        if (brain != null) brain.enabled = false;
        var target = new Vector3(x, y, z);
        AddTemporaryColliders(scene, target, distance * 1.5f);
        var position = ClearViewpoint(target, distance);
        mainCamera.transform.SetPositionAndRotation(position, Quaternion.LookRotation(target - position));
        foreach (var lodGroup in scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<LODGroup>())) lodGroup.ForceLOD(forceLod);
        return "camera=" + mainCamera.name + " at " + position + " forceLod=" + forceLod;
    }

    /// <summary>
    /// Picks a camera position with a clear line of sight to the target: tries the full distance, then half, then a
    /// quarter (so it fits inside rooms), and at each distance directions slightly above, level, then below (below
    /// finds ceilings from inside). Trigger volumes are ignored. Returns the first spot that is not inside geometry and
    /// sees the target unblocked; otherwise the spot whose view reaches furthest towards the target.
    /// </summary>
    private static Vector3 ClearViewpoint(Vector3 target, float distance)
    {
        float[] distanceScales = { 1f, 0.5f, 0.25f };
        float[] elevations = { 0.35f, 0f, -0.35f };
        var best = target + new Vector3(0.7f, 0.45f, -0.7f) * distance;
        float bestReach = -1f;
        foreach (float distanceScale in distanceScales)
        {
            float tryDistance = Mathf.Max(1.5f, distance * distanceScale);
            foreach (float elevation in elevations)
            {
                for (int step = 0; step < 8; step++)
                {
                    float angle = step * Mathf.PI / 4f + Mathf.PI / 4f;
                    var direction = new Vector3(Mathf.Cos(angle), elevation, Mathf.Sin(angle)).normalized;
                    var position = target + direction * tryDistance;
                    if (Physics.CheckSphere(position, 0.25f, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore)) continue;
                    float reach = Physics.Raycast(position, -direction, out RaycastHit hit, tryDistance, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore)
                        ? hit.distance / tryDistance : 1f;
                    if (reach >= 0.7f) return position;
                    if (reach > bestReach) { bestReach = reach; best = position; }
                }
            }
        }
        return best;
    }

    /// <summary>
    /// Gives every renderer near the target a temporary MeshCollider (QaView never saves, so they vanish when the scene
    /// is reopened), so line-of-sight tests also see roofs and walls that have no colliders of their own.
    /// </summary>
    private static void AddTemporaryColliders(Scene scene, Vector3 target, float radius)
    {
        foreach (var renderer in scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<MeshRenderer>()))
        {
            if (renderer.GetComponent<Collider>() != null || renderer.bounds.SqrDistance(target) > radius * radius) continue;
            var filter = renderer.GetComponent<MeshFilter>();
            if (filter == null || filter.sharedMesh == null) continue;
            renderer.gameObject.AddComponent<MeshCollider>().sharedMesh = filter.sharedMesh;
        }
        Physics.SyncTransforms();
    }

    /// <summary>
    /// After a bake, raises Scale In Lightmap on every merged lightmapped mesh whose measured texel density fell below
    /// its sources' (Unity sizes a merged mesh slightly smaller than the sum of its parts, more so when it holds many
    /// small pieces). The scale grows by exactly the measured shortfall, capped at MaxDensityCorrection, and the scene is
    /// saved. Returns how many meshes changed; when any did, bake again and run Verify.
    /// </summary>
    public static string CorrectDensity()
    {
        var scene = SceneManager.GetActiveScene();
        if (!File.Exists(WorkingCopyMarker(scene.path))) throw new InvalidOperationException(scene.path + " is not a bt-combine working copy.");
        string manifestPath = Path.Combine(ReportFolderFor(scene.path), "manifest.json");
        var manifest = RunRecord.FromJson(File.ReadAllText(manifestPath));
        var report = new StringBuilder();
        int corrected = 0;
        foreach (var group in manifest.groups.Where(g => g.lightmapped && g.densityBefore > 0f))
        {
            var root = FindByPath(scene, group.combinedPath);
            if (root == null) continue;
            var renderer = root.GetComponentsInChildren<MeshRenderer>().FirstOrDefault(IsLightmapped);
            if (renderer == null) continue;
            float density = TexelDensity(renderer);
            if (density <= 0f) continue;
            float ratio = density / group.densityBefore;
            if (ratio >= DensityTarget) continue;
            float factor = Mathf.Min(1f / ratio, MaxDensityCorrection);
            var serialized = new SerializedObject(renderer);
            var scale = serialized.FindProperty("m_ScaleInLightmap");
            float before = scale.floatValue;
            scale.floatValue = before * factor;
            serialized.ApplyModifiedPropertiesWithoutUndo();
            corrected++;
            report.AppendLine("  " + group.name + " density " + density.ToString("0.0") + "/" + group.densityBefore.ToString("0.0")
                + " -> Scale In Lightmap " + before.ToString("0.###") + " x" + factor.ToString("0.00") + " = " + scale.floatValue.ToString("0.###"));
        }
        if (corrected > 0)
        {
            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene);
        }
        return "corrected=" + corrected + (corrected > 0 ? " (bake again, then Verify)" : "") + "\n" + report;
    }

    /// <summary>Merged meshes keeping less than this share of their sources' texel density get a Scale In Lightmap correction.</summary>
    private const float DensityTarget = 0.95f;

    /// <summary>Largest Scale In Lightmap multiplier one correction pass applies.</summary>
    private const float MaxDensityCorrection = 2f;

    // ------------------------------------------------------------------------------------------------ planning

    /// <summary>Scene-wide facts the planner reads many times.</summary>
    private sealed class SceneContext
    {
        public Scene Scene;
        public Options Options;
        public HashSet<GameObject> Referenced;
        public List<Light> RuntimeLights;
        public Dictionary<Renderer, HashSet<Light>> LightCache = new Dictionary<Renderer, HashSet<Light>>();
        public Dictionary<Renderer, LODGroup> LodOwner = new Dictionary<Renderer, LODGroup>();
        public Dictionary<UnityEngine.Object, int> Ids = new Dictionary<UnityEngine.Object, int>();
        public Dictionary<Shader, string> ShaderGraphVerdicts = new Dictionary<Shader, string>();
        public bool HasLightProbes;
        public int MaxLights;
        public float TexelsPerUnit;
        public int AtlasSize;
        public float LodBias;
        public float FieldOfView;

        /// <summary>A stable small id for an object within this run (portable across Unity versions).</summary>
        public int IdOf(UnityEngine.Object target)
        {
            if (target == null) return 0;
            if (!Ids.TryGetValue(target, out int id)) { id = Ids.Count + 1; Ids[target] = id; }
            return id;
        }
    }

    /// <summary>A set of plain static renderers that will become one mesh.</summary>
    private sealed class StaticGroup
    {
        public List<MeshRenderer> Renderers;
        public Transform Container;
    }

    /// <summary>A set of LOD groups that will become one LOD group with one merged renderer per level.</summary>
    private sealed class LodCluster
    {
        public List<LODGroup> Members;
        public Transform Container;
    }

    /// <summary>The planner's result: what merges, what stays, and why.</summary>
    private sealed class Plan
    {
        public SceneContext Context;
        public List<StaticGroup> StaticGroups = new List<StaticGroup>();
        public List<LodCluster> LodClusters = new List<LodCluster>();
        public Dictionary<string, List<string>> Kept = new Dictionary<string, List<string>>();
        public List<string> Singletons = new List<string>();
        public List<string> Advisories = new List<string>();
        public int RenderersBefore;
        public int DrawsBefore;
        public int EligibleStatic;
        public int LodGroupsTotal;
        public int LodGroupsEligible;

        /// <summary>Records that an object stays as it is, for the given reason.</summary>
        public void Keep(string reason, string path)
        {
            if (!Kept.TryGetValue(reason, out var paths)) { paths = new List<string>(); Kept[reason] = paths; }
            paths.Add(path);
        }

        /// <summary>Turns the plan into the serializable record (group names, sizes, savings).</summary>
        public RunRecord ToRecord(string mode)
        {
            var record = new RunRecord { scene = Context.Scene.path, mode = mode, renderersBefore = RenderersBefore, drawsBefore = DrawsBefore };
            foreach (var group in StaticGroups) record.groups.Add(DescribeStatic(group, Context));
            foreach (var cluster in LodClusters) record.groups.Add(DescribeLod(cluster, Context));
            record.renderersAfter = RenderersBefore - record.groups.Sum(g => g.sources.Length) + record.groups.Sum(g => Math.Max(1, g.lodLevels));
            record.drawsAfter = DrawsBefore - record.groups.Sum(g => g.drawsBefore - g.drawsAfter);
            record.advisories.AddRange(Advisories);
            return record;
        }

        /// <summary>Builds the human report.</summary>
        public string ToMarkdown(RunRecord record, Options options)
        {
            var text = new StringBuilder();
            text.AppendLine("# bt-combine analysis — " + record.scene + "\n");
            text.AppendLine("| | Before | After (planned) |\n|---|---|---|");
            text.AppendLine("| Mesh renderers | " + record.renderersBefore + " | " + record.renderersAfter + " |");
            text.AppendLine("| Draw calls (est., LOD0) | " + record.drawsBefore + " | " + record.drawsAfter + " |");
            text.AppendLine("| Static groups / LOD clusters | | " + StaticGroups.Count + " / " + LodClusters.Count + " |");
            text.AppendLine("\nSettings: cell " + options.cellSize + " m, spread " + options.maxSpread + " m, atlas share " + options.maxAtlasShare
                + ", max lights per mesh " + Context.MaxLights + ", Shader Graphs " + (options.includeShaderGraphs ? "scanned" : "excluded") + ", LOD clusters " + (options.combineLods ? "on" : "off") + ".\n");
            text.AppendLine("Eligible static renderers: " + EligibleStatic + ". LOD groups: " + LodGroupsEligible + " eligible of " + LodGroupsTotal + ".\n");

            if (record.advisories.Count > 0)
            {
                text.AppendLine("## Scene advisories\n");
                foreach (var advisory in record.advisories) text.AppendLine("- " + advisory);
                text.AppendLine();
            }
            text.AppendLine("## Planned merges\n");
            text.AppendLine("| Name | Kind | Pieces | Verts | Draws | Probe | Lights | Atlas | Spread | Container |\n|---|---|---|---|---|---|---|---|---|---|");
            foreach (var group in record.groups)
            {
                text.AppendLine("| " + group.name + " | " + group.kind + (group.lodLevels > 0 ? " (" + group.lodLevels + " levels, size x" + group.sizeRatio.ToString("0.0") + ")" : "")
                    + " | " + group.sources.Length + " | " + group.vertices + " | " + group.drawsBefore + " → " + group.drawsAfter + " | " + group.probe
                    + " | " + group.lights + " | " + (group.lightmapped ? group.atlasShare.ToString("0.00") : "probe/none") + " | " + group.spreadMeters.ToString("0.0") + " m | " + group.container + " |");
            }
            text.AppendLine("\n<details><summary>Pieces in each merge</summary>\n");
            foreach (var group in record.groups) text.AppendLine("- **" + group.name + "**: " + string.Join(", ", group.sources));
            text.AppendLine("\n</details>\n");

            text.AppendLine("## Kept separate — by reason\n\n| Reason | Count | Examples |\n|---|---|---|");
            foreach (var pair in Kept.OrderByDescending(p => p.Value.Count))
            {
                text.AppendLine("| " + pair.Key + " | " + pair.Value.Count + " | " + string.Join(", ", pair.Value.Take(4).Select(p => "`" + p + "`")) + " |");
            }
            text.AppendLine("\n## Eligible but alone (" + Singletons.Count + ")\n");
            text.AppendLine("Nothing compatible close enough to merge with: " + string.Join(", ", Singletons.Take(25).Select(p => "`" + p + "`")) + (Singletons.Count > 25 ? " …" : ""));
            return text.ToString();
        }
    }

    /// <summary>Plans every merge for the scene: per-renderer and per-LOD-group verdicts, grouping, then splitting.</summary>
    private static Plan BuildPlan(Scene scene, Options options)
    {
        var context = CreateContext(scene, options);
        var plan = new Plan { Context = context };
        CountScene(scene, out plan.RenderersBefore, out plan.DrawsBefore);
        AddSceneAdvisories(plan);

        var allRenderers = scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<MeshRenderer>(false)).Where(r => r.enabled).ToList();
        var staticCandidates = new List<MeshRenderer>();
        foreach (var renderer in allRenderers)
        {
            if (context.LodOwner.ContainsKey(renderer)) continue;
            string reason = RendererVerdict(renderer, context, false, 0);
            if (reason == null) staticCandidates.Add(renderer);
            else plan.Keep(reason, PathOf(renderer.transform));
        }
        plan.EligibleStatic = staticCandidates.Count;

        foreach (var keyed in staticCandidates.GroupBy(renderer => StaticKey(renderer, context)))
        {
            var split = new List<List<MeshRenderer>>();
            SplitRecursively(keyed.ToList(), r => r.bounds, group => StaticGroupNeedsSplit(group, context), split);
            foreach (var group in split)
            {
                if (group.Count < 2) { plan.Singletons.Add(PathOf(group[0].transform)); continue; }
                plan.StaticGroups.Add(new StaticGroup { Renderers = group, Container = FindContainer(group[0].transform.parent, context) });
            }
        }

        var lodGroups = scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<LODGroup>(false)).Where(g => g.enabled).ToList();
        plan.LodGroupsTotal = lodGroups.Count;
        var lodCandidates = new List<LODGroup>();
        foreach (var lodGroup in lodGroups)
        {
            string reason = options.combineLods ? LodGroupVerdict(lodGroup, context) : "LOD clusters turned off";
            if (reason == null) lodCandidates.Add(lodGroup);
            else plan.Keep("LOD group: " + reason, PathOf(lodGroup.transform));
        }
        plan.LodGroupsEligible = lodCandidates.Count;
        foreach (var keyed in lodCandidates.GroupBy(lodGroup => LodKey(lodGroup, context)))
        {
            var split = new List<List<LODGroup>>();
            SplitRecursively(keyed.ToList(), LodWorldBounds, cluster => LodClusterNeedsSplit(cluster, context), split);
            foreach (var cluster in split)
            {
                if (cluster.Count < 2) { plan.Singletons.Add(PathOf(cluster[0].transform) + " (LOD)"); continue; }
                plan.LodClusters.Add(new LodCluster { Members = cluster, Container = FindContainer(cluster[0].transform.parent, context) });
            }
        }
        return plan;
    }

    /// <summary>Collects the scene-wide facts: references, runtime lights, LOD ownership, lightmap settings.</summary>
    private static SceneContext CreateContext(Scene scene, Options options)
    {
        var context = new SceneContext { Scene = scene, Options = options };
        context.Referenced = CollectSerializedReferences(scene);
        context.RuntimeLights = scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<Light>(false))
            .Where(light => light.enabled && light.lightmapBakeType != LightmapBakeType.Baked
                && (light.type == LightType.Directional || light.type == LightType.Point || light.type == LightType.Spot)).ToList();
        foreach (var lodGroup in scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<LODGroup>(true)))
            foreach (var lod in lodGroup.GetLODs())
                foreach (var renderer in lod.renderers)
                    if (renderer != null && !context.LodOwner.ContainsKey(renderer)) context.LodOwner[renderer] = lodGroup;
        context.HasLightProbes = LightmapSettings.lightProbes != null && LightmapSettings.lightProbes.count > 0;
        context.MaxLights = MaxLightsPerMesh();
        LightingSettings lightingSettings = null;
        try { lightingSettings = Lightmapping.lightingSettings; } catch (Exception) { /* no Lighting Settings asset */ }
        context.TexelsPerUnit = lightingSettings != null ? lightingSettings.lightmapResolution : 10f;
        context.AtlasSize = lightingSettings != null ? lightingSettings.lightmapMaxSize : 1024;
        context.LodBias = QualitySettings.lodBias;
        var mainCamera = Camera.main;
        context.FieldOfView = mainCamera != null ? mainCamera.fieldOfView : 60f;
        return context;
    }

    /// <summary>Scene-level notes for the report: lighting state and things the user could change to merge more.</summary>
    private static void AddSceneAdvisories(Plan plan)
    {
        var scene = plan.Context.Scene;
        string lightingData = Lightmapping.lightingDataAsset != null ? AssetDatabase.GetAssetPath(Lightmapping.lightingDataAsset) : "";
        string ownFolder = Path.ChangeExtension(scene.path, null).Replace('\\', '/') + "/";
        if (lightingData == "") plan.Advisories.Add("The scene has no baked lighting yet. Merges are planned from the static flags; bake after applying.");
        else if (!lightingData.StartsWith(ownFolder)) plan.Advisories.Add("The scene uses another scene's LightingData (`" + lightingData + "`), typical of a copied scene. The combined copy gets its own bake.");
        if (!plan.Context.HasLightProbes) plan.Advisories.Add("No baked light probes: probe-lit pieces are judged by locality only.");
        if (!ToolkitPacksSourceUVs()) plan.Advisories.Add("**This toolkit build lacks Pack Source Lightmap UVs — Apply will refuse (vertex bloat).**");
        plan.Advisories.Add("Runtime (Realtime/Mixed) lights: " + plan.Context.RuntimeLights.Count + "; BabylonJS applies at most " + plan.Context.MaxLights + " per mesh, so merges never add lights beyond that.");
    }

    /// <summary>
    /// Returns why a renderer must stay as it is, or null when it can be merged. LOD members skip the LOD check, and
    /// their levels above 0 may be probe-lit (they are only seen from a distance).
    /// </summary>
    private static string RendererVerdict(MeshRenderer renderer, SceneContext context, bool lodMember, int lodLevel)
    {
        var options = context.Options;
        var gameObject = renderer.gameObject;
        if (gameObject.name.StartsWith(StaticPrefix) || gameObject.name.StartsWith(LodPrefix)) return "already a bt-combine result";
        var meshFilter = renderer.GetComponent<MeshFilter>();
        if (meshFilter == null || meshFilter.sharedMesh == null || meshFilter.sharedMesh.vertexCount == 0) return "no mesh";
        if (IsExcludedByName(renderer.transform, options)) return "excluded by --exclude";
        if (options.only.Length > 0 && !options.only.Any(path => PathOf(renderer.transform).StartsWith(path.TrimStart('/')))) return "outside --only";
        var flags = GameObjectUtility.GetStaticEditorFlags(gameObject);
        if (!flags.HasFlag(StaticEditorFlags.ContributeGI) && !flags.HasFlag(StaticEditorFlags.BatchingStatic)) return "not marked static (mark it Static if it never moves)";
        if (gameObject.layer >= FirstReservedLayer) return "on a toolkit reserved layer (28-31)";
        var materials = renderer.sharedMaterials;
        if (materials.Length != meshFilter.sharedMesh.subMeshCount) return "material count differs from submesh count";
        if (materials.Any(material => material == null)) return "missing material";
        if (materials.Any(material => material.renderQueue >= FirstTransparentQueue)) return "transparent (sorted per mesh)";
        foreach (var material in materials)
        {
            string shaderReason = ShaderVerdict(material.shader, context);
            if (shaderReason != null) return shaderReason;
        }
        if (renderer.transform.localToWorldMatrix.determinant < 0f) return "mirrored (negative scale) transform";
        if (renderer.additionalVertexStreams != null) return "vertex-painted (additional vertex streams)";
        if (renderer.GetComponents<MonoBehaviour>().Length > 0) return "has a script component";
        if (context.Referenced.Contains(gameObject)) return "referenced by a script, timeline or component";
        bool probeLit = !IsLightmapped(renderer) && renderer.lightProbeUsage != LightProbeUsage.Off && context.HasLightProbes;
        if (probeLit && !(lodMember && lodLevel > 0)) return "light-probe lit (a merged mesh gets one probe sample)";
        for (var ancestor = renderer.transform; ancestor != null; ancestor = ancestor.parent)
        {
            if (!lodMember && ancestor.GetComponent<LODGroup>() != null) return "inside a LOD group";
            if (ancestor.GetComponent<Animator>() != null || ancestor.GetComponent<Animation>() != null) return "under an Animator / Animation";
            if (ancestor.GetComponent<ParticleSystem>() != null) return "under a particle system";
            if (ancestor.GetComponent<Rigidbody>() != null) return "under a Rigidbody (moves at runtime)";
        }
        return null;
    }

    /// <summary>Returns why a whole LOD group must stay as it is, or null when it can join a LOD cluster.</summary>
    private static string LodGroupVerdict(LODGroup lodGroup, SceneContext context)
    {
        var gameObject = lodGroup.gameObject;
        if (gameObject.name.StartsWith(LodPrefix)) return "already a bt-combine result";
        if (IsExcludedByName(lodGroup.transform, context.Options)) return "excluded by --exclude";
        if (gameObject.GetComponents<MonoBehaviour>().Length > 0) return "has a script component";
        if (context.Referenced.Contains(gameObject)) return "referenced by a script, timeline or component";
        if (lodGroup.transform.localToWorldMatrix.determinant < 0f) return "mirrored (negative scale) transform";
        var lods = lodGroup.GetLODs();
        if (lods.Length < 2) return "fewer than 2 LOD levels";
        var seen = new HashSet<Renderer>();
        for (int level = 0; level < lods.Length; level++)
        {
            var renderers = lods[level].renderers.Where(r => r != null).ToList();
            if (renderers.Count == 0) return "LOD" + level + " is empty";
            foreach (var renderer in renderers)
            {
                if (!seen.Add(renderer)) return "a renderer is used by more than one LOD level";
                if (!(renderer is MeshRenderer meshRenderer)) return "LOD" + level + " has a non-mesh renderer (billboard / skinned)";
                if (!renderer.transform.IsChildOf(lodGroup.transform)) return "a LOD renderer lives outside the group's hierarchy";
                if (!renderer.enabled || !renderer.gameObject.activeInHierarchy) return "LOD" + level + " has a disabled renderer";
                string reason = RendererVerdict(meshRenderer, context, true, level);
                if (reason != null) return "LOD" + level + ": " + reason;
            }
            string signature = RendererSignature(renderers[0], context);
            if (renderers.Any(r => RendererSignature(r, context) != signature)) return "LOD" + level + " renderers have mixed lighting/shadow settings";
        }
        var sharingLevels = Enumerable.Range(1, lods.Length - 1).Where(level => lods[level].renderers.Any(r => r != null && SharesLodZeroLightmap(r))).ToList();
        if (sharingLevels.Count > 0)
        {
            var lodZero = lods[0].renderers.Where(r => r != null).ToList();
            if (lodZero.Count != 1) return "lower LODs share LOD0's lightmap, but LOD0 has several renderers";
            if (!HasLightmapUVs(lodZero[0])) return "lower LODs share LOD0's lightmap, but LOD0 has no lightmap UVs";
            foreach (int level in sharingLevels)
            {
                if (lods[level].renderers.Where(r => r != null).Any(r => !HasLightmapUVs(r))) return "LOD" + level + " shares LOD0's lightmap but has no lightmap UVs";
            }
        }
        return null;
    }

    /// <summary>
    /// Decides whether a shader is safe to merge. Built-ins on the safe list are; Shader Graphs only with
    /// includeShaderGraphs and only when the graph reads no object-space data and does not move vertices.
    /// </summary>
    private static string ShaderVerdict(Shader shader, SceneContext context)
    {
        if (shader == null) return "missing shader";
        if (SafeShaders.Contains(shader.name) || context.Options.extraShaders.Contains(shader.name)) return null;
        string path = AssetDatabase.GetAssetPath(shader);
        if (!path.EndsWith(".shadergraph")) return "custom shader (not on the safe list; add it with --shaders)";
        if (!context.Options.includeShaderGraphs) return "Shader Graph (may use the pivot or object space: wind, holograms; opt in with --include-shadergraphs)";
        if (!context.ShaderGraphVerdicts.TryGetValue(shader, out string verdict))
        {
            verdict = ScanShaderGraph(File.ReadAllText(path));
            context.ShaderGraphVerdicts[shader] = verdict;
        }
        return verdict;
    }

    /// <summary>
    /// Scans a .shadergraph file for what breaks when many objects share one pivot: the Object node, object-space
    /// position / normal / tangent / view nodes, Transform nodes, and anything wired into the vertex Position block.
    /// </summary>
    private static string ScanShaderGraph(string graphText)
    {
        if (graphText.Contains("UnityEditor.ShaderGraph.ObjectNode")) return "Shader Graph uses the Object node (pivot / scale)";
        if (graphText.Contains("UnityEditor.ShaderGraph.TransformationMatrixNode")) return "Shader Graph uses a Transformation Matrix node (model matrix)";
        // A .shadergraph file is a sequence of JSON objects, each closing with "}" on its own line
        var objectSpaceNode = new Regex("\"m_Type\":\\s*\"UnityEditor\\.ShaderGraph\\.(PositionNode|NormalVectorNode|TangentVectorNode|BitangentVectorNode|ViewDirectionNode|ViewVectorNode)\"[\\s\\S]*?\"m_Space\":\\s*0[,\\s]");
        var objectId = new Regex("\"m_ObjectId\":\\s*\"([0-9a-f]+)\"");
        var objectSpaceConversion = new Regex("\"m_Conversion\":\\s*\\{\\s*\"from\":\\s*0\\b|\"m_Conversion\":\\s*\\{[^}]*\"to\":\\s*0\\b");
        foreach (var chunk in graphText.Split(new[] { "\n}\n" }, StringSplitOptions.None))
        {
            if (objectSpaceNode.IsMatch(chunk)) return "Shader Graph reads object-space position/normal";
            // Transform nodes are fine (usually tangent -> world normals) unless they convert from or to Object space (0)
            if (chunk.Contains("\"UnityEditor.ShaderGraph.TransformNode\"") && objectSpaceConversion.IsMatch(chunk)) return "Shader Graph transforms to/from object space";
            if (!chunk.Contains("\"m_SerializedDescriptor\": \"VertexDescription.Position\"")) continue;
            var blockId = objectId.Match(chunk);
            if (blockId.Success && Regex.IsMatch(graphText, "\"m_InputSlot\":\\s*\\{\\s*\"m_Node\":\\s*\\{\\s*\"m_Id\":\\s*\"" + blockId.Groups[1].Value + "\""))
            {
                return "Shader Graph moves vertices (wind / vertex animation)";
            }
        }
        return null;
    }

    /// <summary>Everything two renderers must share to live in one mesh, as a comparable string.</summary>
    private static string RendererSignature(Renderer renderer, SceneContext context)
    {
        var serialized = new SerializedObject(renderer);
        var lightmapParameters = serialized.FindProperty("m_LightmapParameters").objectReferenceValue;
        return string.Join("|", new[]
        {
            renderer.shadowCastingMode.ToString(), renderer.receiveShadows.ToString(), IsLightmapped(renderer).ToString(),
            renderer.lightProbeUsage.ToString(), renderer.reflectionProbeUsage.ToString(), context.IdOf(renderer.probeAnchor).ToString(),
            serialized.FindProperty("m_ScaleInLightmap").floatValue.ToString("0.###"), context.IdOf(lightmapParameters).ToString(),
            renderer.renderingLayerMask.ToString(), renderer.gameObject.layer.ToString(), renderer.gameObject.tag,
            ((int)GameObjectUtility.GetStaticEditorFlags(renderer.gameObject)).ToString(), renderer.staticShadowCaster.ToString(),
        });
    }

    /// <summary>Grouping key for plain static renderers: container, area cell, reflection probe and renderer settings.</summary>
    private static string StaticKey(MeshRenderer renderer, SceneContext context)
    {
        var center = renderer.bounds.center;
        return context.IdOf(FindContainer(renderer.transform.parent, context)) + "|" + CellOf(center, context.Options.cellSize) + "|"
            + context.IdOf(DominantReflectionProbe(renderer)) + "|" + RendererSignature(renderer, context);
    }

    /// <summary>
    /// Grouping key for LOD groups: container, area cell, reflection probe, level count, fade settings, the exact
    /// transition heights (instances of one prefab share them) and every level's renderer settings.
    /// </summary>
    private static string LodKey(LODGroup lodGroup, SceneContext context)
    {
        var lods = lodGroup.GetLODs();
        var firstRenderer = lods[0].renderers.First(r => r != null);
        var key = new StringBuilder();
        key.Append(context.IdOf(FindContainer(lodGroup.transform.parent, context))).Append('|').Append(CellOf(LodWorldBounds(lodGroup).center, context.Options.cellSize));
        key.Append('|').Append(context.IdOf(DominantReflectionProbe(firstRenderer))).Append('|').Append(lods.Length);
        key.Append('|').Append(lodGroup.fadeMode).Append('|').Append(lodGroup.animateCrossFading);
        key.Append('|').Append(lodGroup.gameObject.layer).Append('|').Append(lodGroup.gameObject.tag);
        foreach (var lod in lods)
        {
            key.Append('|').Append(lod.screenRelativeTransitionHeight.ToString("0.###")).Append('/').Append(lod.fadeTransitionWidth.ToString("0.###"));
            key.Append('/').Append(RendererSignature(lod.renderers.First(r => r != null), context));
        }
        return key.ToString();
    }

    /// <summary>True when a static group breaks a budget and must be halved.</summary>
    private static bool StaticGroupNeedsSplit(List<MeshRenderer> group, SceneContext context)
    {
        if (group.Count < 2) return false;
        var merged = MergedBounds(group.Select(r => r.bounds));
        var largest = group.OrderByDescending(r => r.bounds.size.x * r.bounds.size.z).First().bounds;
        if (merged.size.x > largest.size.x + context.Options.maxSpread || merged.size.z > largest.size.z + context.Options.maxSpread) return true;
        if (!ProbeContains(DominantReflectionProbe(group[0]), merged.center)) return true;
        if (IsLightmapped(group[0]) && LightmapTexels(group, context) > AtlasBudget(context)) return true;
        if (group.Sum(r => r.GetComponent<MeshFilter>().sharedMesh.vertexCount) > MaxVerticesPerMesh) return true;
        return LightsAdded(group, context);
    }

    /// <summary>
    /// True when a LOD cluster breaks a budget: its members would switch level too far from their own distance, the
    /// rescaled LOD0 height would leave the valid range, or it breaks the probe, atlas, vertex or light rules.
    /// </summary>
    private static bool LodClusterNeedsSplit(List<LODGroup> cluster, SceneContext context)
    {
        if (cluster.Count < 2) return false;
        var merged = MergedBounds(cluster.Select(LodWorldBounds));
        float clusterSize = Mathf.Max(merged.size.x, merged.size.y, merged.size.z);
        float memberSize = cluster.Average(WorldLodSize);
        float firstTransition = cluster[0].GetLODs()[0].screenRelativeTransitionHeight;
        if (firstTransition * clusterSize / memberSize >= MaxRescaledTransition) return true;
        float switchDistance = memberSize * context.LodBias / (2f * Mathf.Tan(context.FieldOfView * 0.5f * Mathf.Deg2Rad) * Mathf.Max(firstTransition, 0.0001f));
        if (clusterSize * 0.5f > MaxLodSwitchError * switchDistance) return true;
        var levelZero = cluster.SelectMany(g => g.GetLODs()[0].renderers.OfType<MeshRenderer>()).ToList();
        if (!ProbeContains(DominantReflectionProbe(levelZero[0]), merged.center)) return true;
        if (IsLightmapped(levelZero[0]) && LightmapTexels(levelZero, context) > AtlasBudget(context)) return true;
        if (levelZero.Sum(r => r.GetComponent<MeshFilter>().sharedMesh.vertexCount) > MaxVerticesPerMesh) return true;
        return LightsAdded(levelZero, context);
    }

    /// <summary>
    /// True when the merged set would be reached by more runtime lights than BabylonJS applies per mesh, beyond what
    /// its most-lit piece already had — merging must never cost a piece one of its lights.
    /// </summary>
    private static bool LightsAdded(List<MeshRenderer> renderers, SceneContext context)
    {
        var union = new HashSet<Light>();
        int mostPerPiece = 0;
        foreach (var renderer in renderers)
        {
            var lights = LightsReaching(renderer, context);
            union.UnionWith(lights);
            mostPerPiece = Math.Max(mostPerPiece, lights.Count);
        }
        return union.Count > Math.Max(context.MaxLights, mostPerPiece);
    }

    /// <summary>Halves a set along its longest axis until no part needs splitting.</summary>
    private static void SplitRecursively<T>(List<T> items, Func<T, Bounds> boundsOf, Func<List<T>, bool> needsSplit, List<List<T>> output)
    {
        if (items.Count < 2 || !needsSplit(items))
        {
            output.Add(items);
            return;
        }
        var bounds = MergedBounds(items.Select(boundsOf));
        int axis = bounds.size.x >= bounds.size.y && bounds.size.x >= bounds.size.z ? 0 : (bounds.size.y >= bounds.size.z ? 1 : 2);
        var sorted = items.OrderBy(item => boundsOf(item).center[axis]).ToList();
        int half = sorted.Count / 2;
        SplitRecursively(sorted.Take(half).ToList(), boundsOf, needsSplit, output);
        SplitRecursively(sorted.Skip(half).ToList(), boundsOf, needsSplit, output);
    }

    // ------------------------------------------------------------------------------------------------ describing

    /// <summary>Sizes and savings of a planned static merge.</summary>
    private static GroupRecord DescribeStatic(StaticGroup group, SceneContext context)
    {
        var first = group.Renderers[0];
        var materials = group.Renderers.SelectMany(r => r.sharedMaterials).Distinct().ToList();
        var merged = MergedBounds(group.Renderers.Select(r => r.bounds));
        var largest = group.Renderers.OrderByDescending(r => r.bounds.size.x * r.bounds.size.z).First().bounds;
        return new GroupRecord
        {
            name = StaticPrefix + SafeName(group.Container != null ? group.Container.name : "Scene") + "_" + SafeName(materials[0].name) + (materials.Count > 1 ? "_plus" + (materials.Count - 1) : ""),
            kind = "static",
            container = group.Container != null ? PathOf(group.Container) : "(scene root)",
            probe = ProbeName(DominantReflectionProbe(first)),
            lightmapped = IsLightmapped(first),
            vertices = group.Renderers.Sum(r => r.GetComponent<MeshFilter>().sharedMesh.vertexCount),
            drawsBefore = group.Renderers.Sum(r => r.sharedMaterials.Length),
            drawsAfter = materials.Count,
            lights = group.Renderers.SelectMany(r => LightsReaching(r, context)).Distinct().Count(),
            atlasShare = IsLightmapped(first) ? (float)(LightmapTexels(group.Renderers, context) / ((double)context.AtlasSize * context.AtlasSize)) : 0f,
            densityBefore = AreaWeightedDensity(group.Renderers),
            spreadMeters = Mathf.Max(merged.size.x - largest.size.x, merged.size.z - largest.size.z, 0f),
            sources = group.Renderers.Select(r => PathOf(r.transform)).ToArray(),
        };
    }

    /// <summary>Sizes and savings of a planned LOD cluster (draw calls counted at LOD0).</summary>
    private static GroupRecord DescribeLod(LodCluster cluster, SceneContext context)
    {
        var levelZero = cluster.Members.SelectMany(g => g.GetLODs()[0].renderers.OfType<MeshRenderer>()).ToList();
        var merged = MergedBounds(cluster.Members.Select(LodWorldBounds));
        float clusterSize = Mathf.Max(merged.size.x, merged.size.y, merged.size.z);
        var largest = cluster.Members.Select(LodWorldBounds).OrderByDescending(b => b.size.x * b.size.z).First();
        return new GroupRecord
        {
            name = LodPrefix + SafeName(cluster.Container != null ? cluster.Container.name : "Scene") + "_" + SafeName(cluster.Members[0].name) + "_x" + cluster.Members.Count,
            kind = "lod",
            container = cluster.Container != null ? PathOf(cluster.Container) : "(scene root)",
            probe = ProbeName(DominantReflectionProbe(levelZero[0])),
            lightmapped = IsLightmapped(levelZero[0]),
            lodLevels = cluster.Members[0].GetLODs().Length,
            vertices = levelZero.Sum(r => r.GetComponent<MeshFilter>().sharedMesh.vertexCount),
            drawsBefore = levelZero.Sum(r => r.sharedMaterials.Length),
            drawsAfter = levelZero.SelectMany(r => r.sharedMaterials).Distinct().Count(),
            lights = levelZero.SelectMany(r => LightsReaching(r, context)).Distinct().Count(),
            atlasShare = IsLightmapped(levelZero[0]) ? (float)(LightmapTexels(levelZero, context) / ((double)context.AtlasSize * context.AtlasSize)) : 0f,
            densityBefore = AreaWeightedDensity(levelZero),
            spreadMeters = Mathf.Max(merged.size.x - largest.size.x, merged.size.z - largest.size.z, 0f),
            sizeRatio = clusterSize / cluster.Members.Average(WorldLodSize),
            sources = cluster.Members.Select(g => PathOf(g.transform)).ToArray(),
        };
    }

    // ------------------------------------------------------------------------------------------------ applying

    /// <summary>Merges one static group under its container and strips the sources' render components.</summary>
    private static void CombineStaticGroup(StaticGroup group, GroupRecord record, string meshFolder, SceneContext context, RunRecord run)
    {
        var first = group.Renderers[0];
        var combinedObject = CreateChild(record.name, group.Container, first.gameObject);
        var renderer = CombineInto(combinedObject, group.Renderers, record.name, meshFolder, run);
        if (renderer == null)
        {
            UnityEngine.Object.DestroyImmediate(combinedObject);
            return;
        }
        record.combinedPath = PathOf(combinedObject.transform);
        record.meshAssets = new[] { AssetDatabase.GetAssetPath(renderer.GetComponent<MeshFilter>().sharedMesh) };
        record.combinedVertices = renderer.GetComponent<MeshFilter>().sharedMesh.vertexCount;
        foreach (var source in group.Renderers) StripRenderer(source, context);
    }

    /// <summary>
    /// Merges one LOD cluster: every level's renderers become one mesh, held by a new LOD group whose transition
    /// heights are rescaled by the size ratio so members keep switching at the distance they did before.
    /// </summary>
    private static void CombineLodCluster(LodCluster cluster, GroupRecord record, string meshFolder, SceneContext context, RunRecord run)
    {
        var template = cluster.Members[0];
        var templateLods = template.GetLODs();
        var clusterObject = CreateChild(record.name, cluster.Container, template.gameObject);
        var newLods = new LOD[templateLods.Length];
        UvPlacement[] lodZeroPlacements = null;
        for (int level = 0; level < templateLods.Length; level++)
        {
            int currentLevel = level;
            var levelRenderers = cluster.Members.SelectMany(g => g.GetLODs()[currentLevel].renderers.OfType<MeshRenderer>()).ToList();
            var levelObject = CreateChild("LOD" + level, clusterObject.transform, levelRenderers[0].gameObject);
            // Unity gives lower LODs that receive lightmaps without contributing GI the LOD0 lightmap region, so their
            // UV2 must land in exactly the rectangle each member's LOD0 UV2 was packed into
            Action<Mesh> beforeSave = null;
            if (level > 0 && SharesLodZeroLightmap(levelRenderers[0]))
            {
                var placements = lodZeroPlacements;
                beforeSave = mesh => ApplyMemberPlacements(mesh, cluster, currentLevel, placements, record.name, run);
            }
            var renderer = CombineInto(levelObject, levelRenderers, record.name + "_LOD" + level, meshFolder, run, beforeSave);
            if (renderer == null)
            {
                UnityEngine.Object.DestroyImmediate(clusterObject);
                run.warnings.Add(record.name + ": LOD" + level + " produced no mesh; cluster skipped, sources kept.");
                return;
            }
            newLods[level] = new LOD(templateLods[level].screenRelativeTransitionHeight, new Renderer[] { renderer }) { fadeTransitionWidth = templateLods[level].fadeTransitionWidth };
            if (level == 0) lodZeroPlacements = MeasureMemberPlacements(renderer.GetComponent<MeshFilter>().sharedMesh, cluster);
        }

        var lodGroup = clusterObject.AddComponent<LODGroup>();
        lodGroup.fadeMode = template.fadeMode;
        lodGroup.animateCrossFading = template.animateCrossFading;
        lodGroup.SetLODs(newLods);
        lodGroup.RecalculateBounds();
        float sizeRatio = lodGroup.size * MaxAbsScale(clusterObject.transform) / cluster.Members.Average(WorldLodSize);
        float previous = 1f;
        for (int level = 0; level < newLods.Length; level++)
        {
            float rescaled = Mathf.Min(newLods[level].screenRelativeTransitionHeight * sizeRatio, previous - 0.001f);
            newLods[level].screenRelativeTransitionHeight = Mathf.Max(rescaled, 0.0001f);
            previous = newLods[level].screenRelativeTransitionHeight;
        }
        lodGroup.SetLODs(newLods);

        record.sizeRatio = sizeRatio;
        record.combinedPath = PathOf(clusterObject.transform);
        record.meshAssets = newLods.Select(l => AssetDatabase.GetAssetPath(l.renderers[0].GetComponent<MeshFilter>().sharedMesh)).ToArray();
        record.combinedVertices = newLods[0].renderers[0].GetComponent<MeshFilter>().sharedMesh.vertexCount;
        foreach (var member in cluster.Members)
        {
            foreach (var renderer in member.GetLODs().SelectMany(l => l.renderers).OfType<MeshRenderer>().ToList()) StripRenderer(renderer, context);
            var memberObject = member.gameObject;
            UnityEngine.Object.DestroyImmediate(member);
            RemoveIfEmptyLeaf(memberObject, context);
        }
    }

    /// <summary>
    /// Runs the toolkit MeshCombiner over the renderers into a mesh asset on the given object, copies the renderer
    /// settings, and checks the vertex count did not grow. Returns null when nothing was produced.
    /// </summary>
    private static MeshRenderer CombineInto(GameObject target, List<MeshRenderer> sources, string meshName, string meshFolder, RunRecord run, Action<Mesh> beforeSave = null)
    {
        bool lightmapped = IsLightmapped(sources[0]);
        UnityMeshSimplifier.MeshCombiner.AlwaysRegenerateSecondaryUVSet = lightmapped;
        UnityMeshSimplifier.MeshCombiner.AlwaysRegenerateAnimationUVSet = false;
        UnityMeshSimplifier.MeshCombiner.LightmapUVMode = UnityMeshSimplifier.MeshCombiner.LightmapUnwrapMode.FastMeshCombiner;
        UnityMeshSimplifier.MeshCombiner.LightmapUVInit = true;
        UnwrapParam.SetDefaults(out UnityMeshSimplifier.MeshCombiner.LightmapUVParams);

        var warnings = new List<string>();
        var mesh = UnityMeshSimplifier.MeshCombiner.CombineMeshes(target.transform, sources.ToArray(), out Material[] materials, (stage, current, total) => false, message => warnings.Add(message));
        foreach (var warning in warnings) run.warnings.Add(meshName + ": " + warning);
        if (mesh == null)
        {
            run.warnings.Add(meshName + ": the combiner produced no mesh; sources kept.");
            return null;
        }
        int sourceVertices = sources.Sum(r => r.GetComponent<MeshFilter>().sharedMesh.vertexCount);
        if (mesh.vertexCount > sourceVertices * VertexBloatTolerance)
        {
            run.warnings.Add(meshName + ": " + sourceVertices + " source vertices became " + mesh.vertexCount + " (re-unwrapped; check the toolkit build).");
        }
        mesh.name = meshName;
        mesh.RecalculateBounds();
        beforeSave?.Invoke(mesh);
        string assetPath = AssetDatabase.GenerateUniqueAssetPath(meshFolder + "/" + SafeName(meshName) + ".asset");
        AssetDatabase.CreateAsset(mesh, assetPath);
        target.AddComponent<MeshFilter>().sharedMesh = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);
        var renderer = target.AddComponent<MeshRenderer>();
        renderer.sharedMaterials = materials;
        CopyRendererSettings(sources[0], renderer);
        return renderer;
    }

    /// <summary>Where one member's LOD0 lightmap UVs went in the packed LOD0 mesh: packed = source * Scale + Offset.</summary>
    private struct UvPlacement
    {
        public float Scale;
        public Vector2 Offset;
    }

    /// <summary>True when a LOD level borrows LOD0's lightmap: it receives lightmaps but does not contribute GI.</summary>
    private static bool SharesLodZeroLightmap(Renderer renderer)
    {
        return renderer is MeshRenderer meshRenderer && meshRenderer.receiveGI == ReceiveGI.Lightmaps
            && !GameObjectUtility.GetStaticEditorFlags(renderer.gameObject).HasFlag(StaticEditorFlags.ContributeGI);
    }

    /// <summary>
    /// Recovers, per cluster member, the uniform scale and offset the packer applied to its LOD0 lightmap UVs, by
    /// comparing the member's source UV2 bounds with its slice of the packed LOD0 mesh (members are appended in order).
    /// </summary>
    private static UvPlacement[] MeasureMemberPlacements(Mesh packedLodZero, LodCluster cluster)
    {
        var packed = new List<Vector2>();
        packedLodZero.GetUVs(1, packed);
        var placements = new UvPlacement[cluster.Members.Count];
        int vertexOffset = 0;
        for (int member = 0; member < cluster.Members.Count; member++)
        {
            var sourceMesh = cluster.Members[member].GetLODs()[0].renderers.OfType<MeshRenderer>().First().GetComponent<MeshFilter>().sharedMesh;
            var source = new List<Vector2>();
            sourceMesh.GetUVs(1, source);
            var sourceBounds = UvBounds(source, 0, source.Count);
            var packedBounds = UvBounds(packed, vertexOffset, source.Count);
            bool useX = sourceBounds.size.x >= sourceBounds.size.y;
            float sourceSpan = useX ? sourceBounds.size.x : sourceBounds.size.y;
            float packedSpan = useX ? packedBounds.size.x : packedBounds.size.y;
            float scale = sourceSpan > 1e-8f ? packedSpan / sourceSpan : 1f;
            placements[member] = new UvPlacement { Scale = scale, Offset = packedBounds.min - sourceBounds.min * scale };
            vertexOffset += source.Count;
        }
        return placements;
    }

    /// <summary>
    /// Moves each member's lower-LOD lightmap UVs (still in the member's own LOD0 lightmap space) into the rectangle
    /// its LOD0 was packed into, so the merged lower level samples the merged LOD0's lightmap region correctly.
    /// </summary>
    private static void ApplyMemberPlacements(Mesh mesh, LodCluster cluster, int level, UvPlacement[] placements, string name, RunRecord run)
    {
        var uvs = new List<Vector2>();
        mesh.GetUVs(1, uvs);
        int vertexOffset = 0;
        for (int member = 0; member < cluster.Members.Count; member++)
        {
            foreach (var renderer in cluster.Members[member].GetLODs()[level].renderers.OfType<MeshRenderer>())
            {
                int count = renderer.GetComponent<MeshFilter>().sharedMesh.vertexCount;
                for (int vertex = vertexOffset; vertex < vertexOffset + count && vertex < uvs.Count; vertex++)
                {
                    uvs[vertex] = uvs[vertex] * placements[member].Scale + placements[member].Offset;
                }
                vertexOffset += count;
            }
        }
        if (vertexOffset != uvs.Count) run.warnings.Add(name + " LOD" + level + ": shared-lightmap UV remap covered " + vertexOffset + " of " + uvs.Count + " vertices.");
        mesh.SetUVs(1, uvs);
    }

    /// <summary>Bounds of a slice of UVs.</summary>
    private static Rect UvBounds(List<Vector2> uvs, int start, int count)
    {
        var min = new Vector2(float.MaxValue, float.MaxValue);
        var max = new Vector2(float.MinValue, float.MinValue);
        for (int i = start; i < start + count && i < uvs.Count; i++)
        {
            min = Vector2.Min(min, uvs[i]);
            max = Vector2.Max(max, uvs[i]);
        }
        return Rect.MinMaxRect(min.x, min.y, max.x, max.y);
    }

    /// <summary>Creates a child at the container's origin carrying the template's layer, tag and static flags.</summary>
    private static GameObject CreateChild(string name, Transform parent, GameObject template)
    {
        var child = new GameObject(name);
        child.transform.SetParent(parent, false);
        child.layer = template.layer;
        child.tag = template.tag;
        GameObjectUtility.SetStaticEditorFlags(child, GameObjectUtility.GetStaticEditorFlags(template));
        return child;
    }

    /// <summary>Copies lighting, shadow, probe and lightmap settings from a source renderer to the merged one.</summary>
    private static void CopyRendererSettings(MeshRenderer source, MeshRenderer target)
    {
        target.shadowCastingMode = source.shadowCastingMode;
        target.receiveShadows = source.receiveShadows;
        target.receiveGI = source.receiveGI;
        target.lightProbeUsage = source.lightProbeUsage;
        target.reflectionProbeUsage = source.reflectionProbeUsage;
        target.probeAnchor = source.probeAnchor;
        target.renderingLayerMask = source.renderingLayerMask;
        target.motionVectorGenerationMode = source.motionVectorGenerationMode;
        target.allowOcclusionWhenDynamic = source.allowOcclusionWhenDynamic;
        target.staticShadowCaster = source.staticShadowCaster;
        var sourceSettings = new SerializedObject(source);
        var targetSettings = new SerializedObject(target);
        targetSettings.FindProperty("m_ScaleInLightmap").floatValue = sourceSettings.FindProperty("m_ScaleInLightmap").floatValue;
        var stitch = targetSettings.FindProperty("m_StitchLightmapSeams");
        if (stitch != null) stitch.boolValue = sourceSettings.FindProperty("m_StitchLightmapSeams").boolValue;
        targetSettings.FindProperty("m_LightmapParameters").objectReferenceValue = sourceSettings.FindProperty("m_LightmapParameters").objectReferenceValue;
        targetSettings.ApplyModifiedPropertiesWithoutUndo();
    }

    /// <summary>Removes a source's MeshRenderer and MeshFilter (colliders and everything else stay), then tidies empty leaves.</summary>
    private static void StripRenderer(MeshRenderer source, SceneContext context)
    {
        var sourceObject = source.gameObject;
        var filter = sourceObject.GetComponent<MeshFilter>();
        UnityEngine.Object.DestroyImmediate(source);
        if (filter != null) UnityEngine.Object.DestroyImmediate(filter);
        RemoveIfEmptyLeaf(sourceObject, context);
    }

    /// <summary>Deletes a GameObject left with only its Transform and no children, unless a prefab or script owns it.</summary>
    private static void RemoveIfEmptyLeaf(GameObject gameObject, SceneContext context)
    {
        if (gameObject == null || gameObject.transform.childCount > 0 || gameObject.GetComponents<Component>().Length > 1) return;
        if (PrefabUtility.IsPartOfPrefabInstance(gameObject) || context.Referenced.Contains(gameObject)) return;
        UnityEngine.Object.DestroyImmediate(gameObject);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// <summary>True when the installed toolkit can pack source lightmap UVs (no vertex bloat).</summary>
    private static bool ToolkitPacksSourceUVs()
    {
        return typeof(UnityMeshSimplifier.MeshCombiner).GetMethod("PackSourceLightmapUVs", BindingFlags.NonPublic | BindingFlags.Static) != null;
    }

    /// <summary>The scene's maximum lights per material (SceneController.lightingOptions.maximumLights, default 4).</summary>
    private static int MaxLightsPerMesh()
    {
        try { return UnityTools.GetMaxSimultaneousLights(UnityTools.GetDefaultSceneController()); }
        catch (Exception) { return 4; }
    }

    /// <summary>True when the renderer's mesh has a lightmap UV set (UV2).</summary>
    private static bool HasLightmapUVs(Renderer renderer)
    {
        var filter = renderer.GetComponent<MeshFilter>();
        return filter != null && filter.sharedMesh != null && filter.sharedMesh.HasVertexAttribute(VertexAttribute.TexCoord1);
    }

    /// <summary>True when the renderer gets its indirect light from lightmaps.</summary>
    private static bool IsLightmapped(Renderer renderer)
    {
        return renderer is MeshRenderer meshRenderer && meshRenderer.receiveGI == ReceiveGI.Lightmaps
            && GameObjectUtility.GetStaticEditorFlags(renderer.gameObject).HasFlag(StaticEditorFlags.ContributeGI);
    }

    /// <summary>
    /// The highest ancestor, starting at the given parent, reachable through "inert" transforms (no scripts, no
    /// animation, not referenced). A merged mesh lives there, so toggling or moving anything above it still applies.
    /// </summary>
    private static Transform FindContainer(Transform start, SceneContext context)
    {
        if (start == null || !IsInert(start, context)) return start;
        var container = start;
        while (container.parent != null && IsInert(container.parent, context)) container = container.parent;
        return container;
    }

    /// <summary>True when nothing at runtime can move, toggle or animate this transform on its own.</summary>
    private static bool IsInert(Transform node, SceneContext context)
    {
        return node.gameObject.activeSelf && !context.Referenced.Contains(node.gameObject)
            && node.GetComponents<MonoBehaviour>().Length == 0 && node.GetComponent<Animator>() == null && node.GetComponent<Animation>() == null
            && node.GetComponent<UnityEngine.Playables.PlayableDirector>() == null && node.GetComponent<Rigidbody>() == null
            && node.GetComponent<LODGroup>() == null && node.GetComponent<ParticleSystem>() == null;
    }

    /// <summary>
    /// Every GameObject that a component in the scene points at through a serialized field (scripts, timeline
    /// bindings, cameras, constraints…), so nothing a script drives is merged away.
    /// </summary>
    private static HashSet<GameObject> CollectSerializedReferences(Scene scene)
    {
        var referenced = new HashSet<GameObject>();
        foreach (var root in scene.GetRootGameObjects())
            foreach (var component in root.GetComponentsInChildren<Component>(true))
            {
                if (component == null || component is Transform || component is MeshFilter || component is Renderer || component is LODGroup) continue;
                var property = new SerializedObject(component).GetIterator();
                while (property.Next(true))
                {
                    if (property.propertyType != SerializedPropertyType.ObjectReference) continue;
                    var value = property.objectReferenceValue;
                    if (value == null || value == component) continue;
                    var target = value as GameObject ?? (value as Component)?.gameObject;
                    if (target != null && target != component.gameObject) referenced.Add(target);
                }
            }
        return referenced;
    }

    /// <summary>The runtime lights whose range reaches the renderer (directional lights reach everything).</summary>
    private static HashSet<Light> LightsReaching(Renderer renderer, SceneContext context)
    {
        if (context.LightCache.TryGetValue(renderer, out var cached)) return cached;
        var bounds = renderer.bounds;
        var lights = new HashSet<Light>(context.RuntimeLights.Where(light => light.type == LightType.Directional
            || bounds.SqrDistance(light.transform.position) <= light.range * light.range));
        context.LightCache[renderer] = lights;
        return lights;
    }

    /// <summary>The reflection probe that contributes most to the renderer, or null when only the skybox does.</summary>
    private static ReflectionProbe DominantReflectionProbe(Renderer renderer)
    {
        var blend = new List<ReflectionProbeBlendInfo>();
        renderer.GetClosestReflectionProbes(blend);
        return blend.Count > 0 ? blend.OrderByDescending(info => info.weight).First().probe : null;
    }

    /// <summary>True when the probe's box holds the point (always true for the skybox).</summary>
    private static bool ProbeContains(ReflectionProbe probe, Vector3 point)
    {
        return probe == null || probe.bounds.Contains(point);
    }

    /// <summary>The probe's name for reports, or "sky".</summary>
    private static string ProbeName(ReflectionProbe probe)
    {
        return probe != null ? probe.name : "sky";
    }

    /// <summary>The atlas texels one merged lightmapped mesh may use.</summary>
    private static double AtlasBudget(SceneContext context)
    {
        return (double)context.AtlasSize * context.AtlasSize * context.Options.maxAtlasShare;
    }

    /// <summary>Estimated lightmap texels: world area x Scale In Lightmap x resolution squared.</summary>
    private static double LightmapTexels(IEnumerable<MeshRenderer> renderers, SceneContext context)
    {
        double texels = 0;
        foreach (var renderer in renderers)
        {
            float scale = new SerializedObject(renderer).FindProperty("m_ScaleInLightmap").floatValue;
            texels += WorldSurfaceArea(renderer) * scale * context.TexelsPerUnit * context.TexelsPerUnit;
        }
        return texels;
    }

    /// <summary>World-space triangle area of a renderer's mesh, in square meters.</summary>
    private static double WorldSurfaceArea(Renderer renderer)
    {
        var mesh = renderer.GetComponent<MeshFilter>().sharedMesh;
        var localToWorld = renderer.transform.localToWorldMatrix;
        var vertices = mesh.vertices;
        var triangles = mesh.triangles;
        double area = 0;
        for (int i = 0; i + 2 < triangles.Length; i += 3)
        {
            var a = localToWorld.MultiplyPoint3x4(vertices[triangles[i]]);
            var b = localToWorld.MultiplyPoint3x4(vertices[triangles[i + 1]]);
            var c = localToWorld.MultiplyPoint3x4(vertices[triangles[i + 2]]);
            area += Vector3.Cross(b - a, c - a).magnitude * 0.5;
        }
        return area;
    }

    /// <summary>Baked lightmap texels per meter of a renderer (0 when it has no lightmap slot yet).</summary>
    private static float TexelDensity(MeshRenderer renderer)
    {
        if (renderer.lightmapIndex < 0 || renderer.lightmapIndex >= LightmapSettings.lightmaps.Length) return 0f;
        var lightmap = LightmapSettings.lightmaps[renderer.lightmapIndex].lightmapColor;
        if (lightmap == null) return 0f;
        var mesh = renderer.GetComponent<MeshFilter>().sharedMesh;
        var uvs = new List<Vector2>();
        mesh.GetUVs(1, uvs);
        if (uvs.Count == 0) return 0f;
        var triangles = mesh.triangles;
        double uvArea = 0;
        for (int i = 0; i + 2 < triangles.Length; i += 3)
        {
            var edgeA = uvs[triangles[i + 1]] - uvs[triangles[i]];
            var edgeB = uvs[triangles[i + 2]] - uvs[triangles[i]];
            uvArea += Math.Abs(edgeA.x * edgeB.y - edgeA.y * edgeB.x) * 0.5;
        }
        var scaleOffset = renderer.lightmapScaleOffset;
        double texelArea = uvArea * scaleOffset.x * lightmap.width * scaleOffset.y * lightmap.height;
        double worldArea = WorldSurfaceArea(renderer);
        return worldArea > 0 ? (float)Math.Sqrt(texelArea / worldArea) : 0f;
    }

    /// <summary>Area-weighted lightmap density of the sources, recorded before merging for the post-bake check.</summary>
    private static float AreaWeightedDensity(List<MeshRenderer> renderers)
    {
        double weighted = 0, total = 0;
        foreach (var renderer in renderers)
        {
            float density = TexelDensity(renderer);
            if (density <= 0f) continue;
            double area = WorldSurfaceArea(renderer);
            weighted += density * area;
            total += area;
        }
        return total > 0 ? (float)(weighted / total) : 0f;
    }

    /// <summary>The LOD group's world-space bounds (from all its renderers).</summary>
    private static Bounds LodWorldBounds(LODGroup lodGroup)
    {
        return MergedBounds(lodGroup.GetLODs().SelectMany(l => l.renderers).Where(r => r != null).Select(r => r.bounds));
    }

    /// <summary>The LOD group's size in world units (what Unity's switch rule uses).</summary>
    private static float WorldLodSize(LODGroup lodGroup)
    {
        return Mathf.Max(lodGroup.size * MaxAbsScale(lodGroup.transform), 0.0001f);
    }

    /// <summary>Largest absolute axis of the transform's world scale.</summary>
    private static float MaxAbsScale(Transform transform)
    {
        var scale = transform.lossyScale;
        return Mathf.Max(Mathf.Abs(scale.x), Mathf.Abs(scale.y), Mathf.Abs(scale.z));
    }

    /// <summary>Bounds enclosing all the given bounds.</summary>
    private static Bounds MergedBounds(IEnumerable<Bounds> all)
    {
        bool first = true;
        var merged = new Bounds();
        foreach (var bounds in all)
        {
            if (first) { merged = bounds; first = false; }
            else merged.Encapsulate(bounds);
        }
        return merged;
    }

    /// <summary>The area cell ("patch") a point falls in.</summary>
    private static string CellOf(Vector3 point, float cellSize)
    {
        return Mathf.FloorToInt(point.x / cellSize) + "," + Mathf.FloorToInt(point.z / cellSize);
    }

    /// <summary>Counts enabled mesh renderers and their submeshes (draw calls, LOD levels above 0 not counted).</summary>
    private static void CountScene(Scene scene, out int renderers, out int draws)
    {
        var hiddenLods = new HashSet<Renderer>(scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<LODGroup>(false))
            .SelectMany(g => g.GetLODs().Skip(1)).SelectMany(l => l.renderers).Where(r => r != null));
        var all = scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<MeshRenderer>(false)).Where(r => r.enabled).ToList();
        renderers = all.Count;
        draws = all.Where(r => !hiddenLods.Contains(r)).Sum(r => r.sharedMaterials.Length);
    }

    /// <summary>True when the scene already holds bt-combine results.</summary>
    private static bool HasCombinedObjects(Scene scene)
    {
        return scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<Transform>(true))
            .Any(t => t.name.StartsWith(StaticPrefix) || t.name.StartsWith(LodPrefix));
    }

    /// <summary>True when the object or an ancestor matches an --exclude entry (exact name, or prefix ending in *).</summary>
    private static bool IsExcludedByName(Transform transform, Options options)
    {
        if (options.exclude.Length == 0) return false;
        for (var node = transform; node != null; node = node.parent)
            foreach (string pattern in options.exclude)
            {
                if (pattern.EndsWith("*") ? node.name.StartsWith(pattern.TrimEnd('*')) : node.name == pattern) return true;
            }
        return false;
    }

    /// <summary>Finds a GameObject in the scene by its slash-separated hierarchy path.</summary>
    private static GameObject FindByPath(Scene scene, string path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        return scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<Transform>(true)).FirstOrDefault(t => PathOf(t) == path)?.gameObject;
    }

    /// <summary>The slash-separated hierarchy path of a transform.</summary>
    private static string PathOf(Transform transform)
    {
        var parts = new List<string>();
        for (var node = transform; node != null; node = node.parent) parts.Insert(0, node.name);
        return string.Join("/", parts);
    }

    /// <summary>A name safe for asset files and GameObjects.</summary>
    private static string SafeName(string name)
    {
        return Regex.Replace(name, "[^A-Za-z0-9_\\-]", "");
    }

    /// <summary>Returns the name, numbered if it was already used.</summary>
    private static string UniqueName(string name, HashSet<string> used)
    {
        string candidate = name;
        for (int suffix = 2; !used.Add(candidate); suffix++) candidate = name + "_" + suffix;
        return candidate;
    }

    /// <summary>
    /// Refuses to continue while any open scene has unsaved changes: switching scenes from a script discards them
    /// without asking, and they may be the user's work.
    /// </summary>
    private static void ThrowIfAnySceneDirty()
    {
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var openScene = SceneManager.GetSceneAt(i);
            if (openScene.isDirty)
            {
                throw new InvalidOperationException("'" + (openScene.path == "" ? openScene.name : openScene.path) + "' has unsaved changes. "
                    + "Ask the user to save or discard them; bt-combine never switches scenes over unsaved work.");
            }
        }
    }

    /// <summary>Marker file written by PrepareCopy; holds the source scene path and proves the scene is a working copy.</summary>
    private static string WorkingCopyMarker(string scenePath)
    {
        return Path.Combine(ReportFolderFor(scenePath), "working-copy.txt");
    }

    /// <summary>Reads options JSON (empty means defaults).</summary>
    private static Options ParseOptions(string json)
    {
        return string.IsNullOrWhiteSpace(json) ? new Options() : JsonUtility.FromJson<Options>(json);
    }

    /// <summary>Folder for a scene's merged mesh assets: &lt;scene folder&gt;/&lt;scene&gt;_CombinedMeshes.</summary>
    private static string MeshFolderFor(string scenePath)
    {
        return Path.GetDirectoryName(scenePath).Replace('\\', '/') + "/" + Path.GetFileNameWithoutExtension(scenePath) + "_CombinedMeshes";
    }

    /// <summary>Folder for a scene's reports: &lt;project&gt;/_combine/&lt;scene&gt;.</summary>
    private static string ReportFolderFor(string scenePath)
    {
        return Path.Combine(Directory.GetParent(Application.dataPath).FullName, "_combine", Path.GetFileNameWithoutExtension(scenePath));
    }

    /// <summary>Creates an asset folder and its parents if missing.</summary>
    private static void EnsureFolder(string folder)
    {
        if (AssetDatabase.IsValidFolder(folder)) return;
        string parent = Path.GetDirectoryName(folder).Replace('\\', '/');
        EnsureFolder(parent);
        AssetDatabase.CreateFolder(parent, Path.GetFileName(folder));
    }
}
