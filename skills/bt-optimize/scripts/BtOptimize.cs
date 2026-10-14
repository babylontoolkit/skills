using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

/// <summary>
/// bt-optimize engine. Surveys the active scene for everything that costs frame time once it is exported to
/// BabylonJS (runtime lights, realtime shadows, post-processing, render resolution, probe-lit and non-static
/// geometry, mirrored transforms, materials and textures), and applies the fixes the skill decides on.
/// Run every entry point with `unity command run_script --file &lt;this file&gt; --entry BtOptimize.&lt;Method&gt;`.
/// </summary>
public static class BtOptimize
{
    /// <summary>Render queues from here up are transparent.</summary>
    private const int FirstTransparentQueue = 2500;

    // ------------------------------------------------------------------------------------------------------------
    // Survey
    // ------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Writes .agents/optimize/&lt;Scene&gt;/survey.md and survey.json for the active scene and returns a short summary.
    /// Read-only: nothing in the scene or project changes.
    /// </summary>
    public static string Survey()
    {
        var scene = SceneManager.GetActiveScene();
        var context = new Context(scene);
        var md = new StringBuilder();
        var json = new Dictionary<string, object>();
        md.AppendLine("# bt-optimize survey — " + scene.name);
        md.AppendLine();
        md.AppendLine("Scene: `" + scene.path + "`  ");
        md.AppendLine("Generated: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm"));
        md.AppendLine();

        SurveyLights(context, md, json);
        SurveyRenderers(context, md, json);
        SurveyPostProcessing(context, md, json);
        SurveyPipeline(md, json);
        SurveyExporter(context, md, json);
        SurveyProbes(context, md, json);
        SurveyMaterials(context, md, json);

        string folder = ReportFolder(scene);
        File.WriteAllText(Path.Combine(folder, "survey.md"), md.ToString());
        File.WriteAllText(Path.Combine(folder, "survey.json"), ToJson(json, 0));
        return "survey written to " + folder + "\n" + context.Summary.ToString();
    }

    /// <summary>Every light, how it reaches BabylonJS, and whether anything at runtime drives it.</summary>
    private static void SurveyLights(Context context, StringBuilder md, Dictionary<string, object> json)
    {
        var rows = new List<object>();
        md.AppendLine("## Lights");
        md.AppendLine();
        md.AppendLine("| Light | Type | Mode | Shadows | Range | Intensity | Renderers reached | Driven by |");
        md.AppendLine("|---|---|---|---|---|---|---|---|");
        int realtime = 0, shadowed = 0, baked = 0;
        foreach (var light in context.Lights)
        {
            string mode = light.lightmapBakeType.ToString();
            bool runtime = light.lightmapBakeType != LightmapBakeType.Baked && light.type != LightType.Rectangle && light.type != LightType.Disc;
            if (runtime) realtime++; else baked++;
            if (runtime && light.shadows != LightShadows.None) shadowed++;
            int reached = runtime ? context.Renderers.Count(renderer => Reaches(light, renderer)) : 0;
            string driver = DriverOf(light.gameObject, context);
            md.AppendLine("| " + PathOf(light.transform) + " | " + light.type + " | " + mode + " | " + light.shadows + " | " + light.range.ToString("0.#")
                + " | " + light.intensity.ToString("0.##") + " | " + reached + " | " + (driver ?? "—") + " |");
            rows.Add(new Dictionary<string, object> {
                { "path", PathOf(light.transform) }, { "type", light.type.ToString() }, { "mode", mode }, { "runtime", runtime },
                { "shadows", light.shadows.ToString() }, { "range", light.range }, { "intensity", light.intensity },
                { "renderersReached", reached }, { "driver", driver ?? "" } });
        }
        md.AppendLine();
        md.AppendLine("Runtime lights (Realtime + Mixed): **" + realtime + "**, casting shadows: **" + shadowed + "**, Baked: " + baked + ".");
        md.AppendLine();
        // Inactive lights are skipped by Tune, but a browser-side script may activate their object (they then cost like any runtime light).
        var inactive = context.All<Light>().Where(light => !light.gameObject.activeInHierarchy && light.lightmapBakeType != LightmapBakeType.Baked).ToList();
        if (inactive.Count > 0)
        {
            md.AppendLine("Inactive runtime lights (a script may switch them on in the browser; check the profile's census): " + inactive.Count);
            foreach (var light in inactive.Take(12)) md.AppendLine("- " + PathOf(light.transform) + " (" + light.type + " " + light.lightmapBakeType + ", range " + light.range.ToString("0.#") + ", driven by " + (WebDriverOf(light.gameObject, context) ?? DriverOf(light.gameObject, context) ?? "—") + ")");
            md.AppendLine();
        }
        context.Summary.AppendLine("lights runtime=" + realtime + " shadowed=" + shadowed + " baked=" + baked);
        json["lights"] = rows;
    }

    /// <summary>Static flags, GI mode, mirrored transforms and why non-static renderers are not static.</summary>
    private static void SurveyRenderers(Context context, StringBuilder md, Dictionary<string, object> json)
    {
        var renderers = context.Renderers;
        int lightmapped = 0, probeLit = 0, notStatic = 0, mirrored = 0, transparent = 0;
        var probeLitGroups = new Dictionary<string, Group>();
        var nonStaticGroups = new Dictionary<string, Group>();
        var mirroredGroups = new Dictionary<string, Group>();
        foreach (var renderer in renderers)
        {
            var flags = GameObjectUtility.GetStaticEditorFlags(renderer.gameObject);
            bool isStatic = flags.HasFlag(StaticEditorFlags.ContributeGI) || flags.HasFlag(StaticEditorFlags.BatchingStatic);
            var lod = renderer.GetComponentInParent<LODGroup>();
            int level = lod != null ? LodLevelOf(lod, renderer) : -1;
            bool receivesLightmaps = renderer is MeshRenderer meshRenderer && meshRenderer.receiveGI == ReceiveGI.Lightmaps;
            // A lower LOD level that receives lightmaps without contributing GI borrows LOD0's lightmap region.
            bool isLightmapped = receivesLightmaps && (flags.HasFlag(StaticEditorFlags.ContributeGI) || level > 0);
            if (renderer.sharedMaterials.Any(material => material != null && material.renderQueue >= FirstTransparentQueue)) transparent++;
            string key = GroupKey(renderer);
            if (isLightmapped) lightmapped++;
            else if (renderer.lightProbeUsage != LightProbeUsage.Off)
            {
                probeLit++;
                if (level <= 0) Add(probeLitGroups, key, renderer, ProbeLitNote(renderer, flags, level));
            }
            if (!isStatic)
            {
                notStatic++;
                Add(nonStaticGroups, key, renderer, DriverOf(renderer.gameObject, context) ?? "nothing found that moves it");
            }
            if (renderer.transform.localToWorldMatrix.determinant < 0f)
            {
                mirrored++;
                var scale = renderer.transform.lossyScale;
                Add(mirroredGroups, key, renderer, "scale " + scale.x.ToString("0.##") + "," + scale.y.ToString("0.##") + "," + scale.z.ToString("0.##"));
            }
        }
        md.AppendLine("## Renderers");
        md.AppendLine();
        md.AppendLine("Total **" + renderers.Count + "**: lightmapped " + lightmapped + ", probe-lit " + probeLit + ", not static " + notStatic
            + ", mirrored " + mirrored + ", transparent " + transparent + ".");
        md.AppendLine();
        WriteGroups(md, "Probe-lit (LOD0 / non-LOD) — could be lightmapped", probeLitGroups);
        WriteGroups(md, "Not static — and what moves them", nonStaticGroups);
        WriteGroups(md, "Mirrored (negative scale)", mirroredGroups);
        context.Summary.AppendLine("renderers=" + renderers.Count + " lightmapped=" + lightmapped + " probeLit=" + probeLit + " notStatic=" + notStatic + " mirrored=" + mirrored);
        json["renderers"] = new Dictionary<string, object> {
            { "total", renderers.Count }, { "lightmapped", lightmapped }, { "probeLit", probeLit }, { "notStatic", notStatic },
            { "mirrored", mirrored }, { "transparent", transparent },
            { "probeLitGroups", GroupsToJson(probeLitGroups) }, { "nonStaticGroups", GroupsToJson(nonStaticGroups) },
            { "mirroredGroups", GroupsToJson(mirroredGroups) } };
    }

    /// <summary>Every Volume and its active overrides, plus every camera's anti-aliasing and post-processing flags.</summary>
    private static void SurveyPostProcessing(Context context, StringBuilder md, Dictionary<string, object> json)
    {
        md.AppendLine("## Post-processing and cameras");
        md.AppendLine();
        var volumes = new List<object>();
        foreach (var volume in context.All<Volume>())
        {
            var profile = volume.sharedProfile;
            var overrides = new List<object>();
            md.AppendLine("- Volume `" + PathOf(volume.transform) + "` (" + (volume.isGlobal ? "global" : "local") + ", weight " + volume.weight.ToString("0.##")
                + ", priority " + volume.priority + ") profile `" + (profile != null ? profile.name : "none") + "`");
            if (profile != null)
                foreach (var component in profile.components)
                {
                    if (component == null) continue;
                    var parameters = new List<string>();
                    foreach (var field in component.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
                    {
                        if (!(field.GetValue(component) is VolumeParameter parameter) || !parameter.overrideState) continue;
                        object value = parameter.GetType().GetProperty("value")?.GetValue(parameter);
                        parameters.Add(field.Name + "=" + FormatValue(value));
                    }
                    md.AppendLine("  - " + component.GetType().Name + (component.active ? "" : " (inactive)") + ": " + string.Join(", ", parameters));
                    overrides.Add(new Dictionary<string, object> { { "type", component.GetType().Name }, { "active", component.active }, { "parameters", parameters } });
                }
            volumes.Add(new Dictionary<string, object> { { "path", PathOf(volume.transform) }, { "global", volume.isGlobal }, { "profile", profile != null ? AssetDatabase.GetAssetPath(profile) : "" }, { "overrides", overrides } });
        }
        var cameras = new List<object>();
        foreach (var camera in context.All<Camera>())
        {
            var data = camera.GetComponents<Component>().FirstOrDefault(component => component != null && component.GetType().Name == "UniversalAdditionalCameraData");
            string aa = "", aaQuality = "", post = "";
            if (data != null)
            {
                var serialized = new SerializedObject(data);
                aa = EnumName(serialized.FindProperty("m_Antialiasing"));
                aaQuality = EnumName(serialized.FindProperty("m_AntialiasingQuality"));
                post = serialized.FindProperty("m_RenderPostProcessing")?.boolValue.ToString() ?? "";
            }
            md.AppendLine("- Camera `" + PathOf(camera.transform) + "` enabled=" + camera.isActiveAndEnabled + " AA=" + aa + " (" + aaQuality + ") post=" + post
                + " HDR=" + camera.allowHDR + " MSAA=" + camera.allowMSAA + " far=" + camera.farClipPlane);
            cameras.Add(new Dictionary<string, object> { { "path", PathOf(camera.transform) }, { "enabled", camera.isActiveAndEnabled }, { "antialiasing", aa }, { "antialiasingQuality", aaQuality }, { "postProcessing", post }, { "far", camera.farClipPlane } });
        }
        md.AppendLine();
        json["volumes"] = volumes;
        json["cameras"] = cameras;
    }

    /// <summary>The render pipeline asset's resolution, MSAA and shadow settings (read through serialized names).</summary>
    private static void SurveyPipeline(StringBuilder md, Dictionary<string, object> json)
    {
        var pipeline = QualitySettings.renderPipeline != null ? QualitySettings.renderPipeline : GraphicsSettings.defaultRenderPipeline;
        var values = new Dictionary<string, object>();
        md.AppendLine("## Render pipeline asset");
        md.AppendLine();
        if (pipeline == null) { md.AppendLine("Built-in render pipeline."); md.AppendLine(); json["pipeline"] = values; return; }
        values["asset"] = AssetDatabase.GetAssetPath(pipeline);
        var serialized = new SerializedObject(pipeline);
        foreach (var name in new[] { "m_RenderScale", "m_MSAA", "m_MainLightShadowsSupported", "m_MainLightShadowmapResolution", "m_AdditionalLightsRenderingMode",
            "m_AdditionalLightsPerObjectLimit", "m_AdditionalLightShadowsSupported", "m_AdditionalLightsShadowmapResolution", "m_ShadowDistance",
            "m_ShadowCascadeCount", "m_SoftShadowsSupported", "m_SupportsHDR", "m_ReflectionProbeBlending", "m_ReflectionProbeBoxProjection" })
        {
            var property = serialized.FindProperty(name);
            if (property == null) continue;
            values[name] = PropertyValue(property);
        }
        md.AppendLine("`" + values["asset"] + "`: " + string.Join(", ", values.Where(pair => pair.Key != "asset").Select(pair => pair.Key.Substring(2) + "=" + pair.Value)));
        md.AppendLine();
        json["pipeline"] = values;
    }

    /// <summary>The toolkit exporter settings that shape runtime cost, and the scene controller's light budget.</summary>
    private static void SurveyExporter(Context context, StringBuilder md, Dictionary<string, object> json)
    {
        var values = new Dictionary<string, object>();
        var info = CanvasToolsInfo.Instance;
        foreach (var name in new[] { "AdaptToDeviceRatio", "GpuRenderingMode", "PerformanceMode", "EnableAntiAliasing", "PreserveDrawBuffer", "EnableStencilBuffer",
            "FreezeStaticMeshes", "ExportMeshInstances", "TextureImageFormat", "TextureImageQuality", "SuperCompressKtx2Lightmaps", "SuperCompressWebpLightmaps",
            "ReflectionProbePower", "ExportFileFormat", "MeshExportSystem" })
        {
            var property = typeof(CanvasToolsInfo).GetProperty(name);
            if (property != null) values[name] = property.GetValue(info);
        }
        try { values["maximumLights"] = UnityTools.GetMaxSimultaneousLights(UnityTools.GetDefaultSceneController()); } catch (Exception) { values["maximumLights"] = 4; }
        md.AppendLine("## Exporter settings (runtime cost)");
        md.AppendLine();
        md.AppendLine(string.Join(", ", values.Select(pair => pair.Key + "=" + pair.Value)));
        md.AppendLine();
        md.AppendLine("AdaptToDeviceRatio 0 = render at device pixels on desktop (4× pixels on a 2× screen); GpuRenderingMode 1/2 = WebGPU snapshot rendering standard/fast.");
        md.AppendLine();
        json["exporter"] = values;
    }

    /// <summary>Reflection probes and light probes.</summary>
    private static void SurveyProbes(Context context, StringBuilder md, Dictionary<string, object> json)
    {
        var probes = context.All<ReflectionProbe>().ToList();
        int lightProbes = context.All<LightProbeGroup>().Sum(group => group.probePositions.Length);
        md.AppendLine("## Probes");
        md.AppendLine();
        md.AppendLine("Reflection probes: " + probes.Count + " (" + string.Join(", ", probes.GroupBy(probe => probe.mode + "@" + probe.resolution).Select(group => group.Count() + "× " + group.Key))
            + "). Light probes: " + lightProbes + ".");
        md.AppendLine();
        json["probes"] = new Dictionary<string, object> { { "reflection", probes.Count }, { "realtimeReflection", probes.Count(probe => probe.mode == ReflectionProbeMode.Realtime) }, { "lightProbes", lightProbes } };
    }

    /// <summary>Unique materials and textures the renderers use, and the biggest textures.</summary>
    private static void SurveyMaterials(Context context, StringBuilder md, Dictionary<string, object> json)
    {
        var materials = new HashSet<Material>(context.Renderers.SelectMany(renderer => renderer.sharedMaterials).Where(material => material != null));
        var textures = new HashSet<Texture>();
        foreach (var material in materials)
            foreach (var name in material.GetTexturePropertyNames())
            {
                var texture = material.GetTexture(name);
                if (texture != null) textures.Add(texture);
            }
        long pixels = textures.Sum(texture => (long)texture.width * texture.height);
        var biggest = textures.OrderByDescending(texture => (long)texture.width * texture.height).Take(15).ToList();
        md.AppendLine("## Materials and textures");
        md.AppendLine();
        md.AppendLine("Unique materials: " + materials.Count + " (" + string.Join(", ", materials.GroupBy(material => material.shader != null ? material.shader.name : "none").OrderByDescending(group => group.Count()).Take(8).Select(group => group.Count() + "× " + group.Key))
            + "). Unique textures: " + textures.Count + ", " + (pixels / 1000000.0).ToString("0") + " Mpx (≈" + (pixels * 4 * 1.33 / 1048576).ToString("0") + " MB uncompressed RGBA).");
        md.AppendLine();
        foreach (var texture in biggest) md.AppendLine("- " + texture.width + "×" + texture.height + " `" + AssetDatabase.GetAssetPath(texture) + "`");
        md.AppendLine();
        context.Summary.AppendLine("materials=" + materials.Count + " textures=" + textures.Count + " texMpx=" + (pixels / 1000000));
        json["materials"] = new Dictionary<string, object> { { "unique", materials.Count }, { "textures", textures.Count }, { "megapixels", pixels / 1000000.0 },
            { "biggest", biggest.Select(texture => (object)(texture.width + "x" + texture.height + " " + AssetDatabase.GetAssetPath(texture))).ToList() } };
    }

    // ------------------------------------------------------------------------------------------------------------
    // Tune — the scene-side fixes, applied to the working copy only
    // ------------------------------------------------------------------------------------------------------------

    /// <summary>Settings for Tune. Every field has a safe default; the skill passes overrides as JSON.</summary>
    [Serializable]
    public class TuneOptions
    {
        /// <summary>Turn runtime point / spot lights that nothing in the browser drives into Baked lights.</summary>
        public bool bakeLights = true;
        /// <summary>
        /// Also bake lights that cast realtime shadows. Off by default: a shadowed key light reaches past geometry its
        /// shadow map ignores (single-sided back faces, the near plane around its fixture) and the lightmapper does not —
        /// baked, Garden's room lights stayed trapped and the rooms went dark. Kept lights lose only their realtime shadows.
        /// </summary>
        public bool bakeShadowedLights = false;
        /// <summary>Light names (or prefixes ending in *) that stay as they are.</summary>
        public string[] keepLights = new string[0];
        /// <summary>Turn realtime shadows off on point / spot lights that stay runtime (each is a full scene pass per frame, six for a point light).</summary>
        public bool pointSpotShadowsOff = true;
        /// <summary>Mark renderers static when nothing in the browser can move them.</summary>
        public bool markStatic = true;
        /// <summary>Switch static, probe-lit renderers that have lightmap UVs (and no vertex animation) to lightmaps.</summary>
        public bool lightmapProbeLit = true;
        /// <summary>Deactivate motion blur overrides whose intensity is 0 in the profiles this scene uses (a no-op in Unity).</summary>
        public bool fixZeroMotionBlur = true;
        /// <summary>Object names (or prefixes ending in *) whose subtrees Tune never touches.</summary>
        public string[] exclude = new string[0];
        /// <summary>Plan only: report every change without making it (works on any scene, including the source).</summary>
        public bool dryRun = false;
    }

    /// <summary>One change Tune made, for the report and for undo.</summary>
    private sealed class Change
    {
        public string Kind, Path, Before, After, Why;
    }

    /// <summary>
    /// Applies the scene-side fixes to the active scene, which must be a bt-optimize working copy, saves it and writes
    /// tune.md / tune.json. Lighting must be re-baked afterwards when lights or GI flags changed.
    /// </summary>
    public static string Tune(string optionsJson)
    {
        var options = string.IsNullOrWhiteSpace(optionsJson) ? new TuneOptions() : JsonUtility.FromJson<TuneOptions>(optionsJson);
        var scene = SceneManager.GetActiveScene();
        string folder = ReportFolder(scene);
        if (!options.dryRun && !File.Exists(Path.Combine(folder, "working-copy.txt")))
            throw new InvalidOperationException(scene.path + " is not a bt-optimize working copy. Run BtCombine.PrepareCopy first; Tune never edits a source scene.");
        var context = new Context(scene);
        var changes = new List<Change>();
        var kept = new List<Change>();

        if (options.bakeLights || options.pointSpotShadowsOff) TuneLights(context, options, changes, kept);
        if (options.markStatic) MarkStatic(context, options, changes, kept);
        if (options.lightmapProbeLit) LightmapProbeLit(context, options, changes, kept);
        if (options.fixZeroMotionBlur) FixZeroMotionBlur(context, changes, options.dryRun);

        if (!options.dryRun)
        {
            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene);
            AssetDatabase.SaveAssets();
        }

        var md = new StringBuilder("# bt-optimize tune" + (options.dryRun ? " plan (dry run — nothing changed)" : "") + " — " + scene.path + "\n\n");
        foreach (var kind in changes.Select(change => change.Kind).Distinct())
        {
            var list = changes.Where(change => change.Kind == kind).ToList();
            md.AppendLine("## " + kind + " — " + list.Count + "\n");
            md.AppendLine("| Object | Before | After | Why |\n|---|---|---|---|");
            foreach (var change in list) md.AppendLine("| " + change.Path + " | " + change.Before + " | " + change.After + " | " + change.Why + " |");
            md.AppendLine();
        }
        md.AppendLine("## Left alone — " + kept.Count + "\n");
        md.AppendLine("| Object | Kind | Why |\n|---|---|---|");
        foreach (var change in kept) md.AppendLine("| " + change.Path + " | " + change.Kind + " | " + change.Why + " |");
        string stem = options.dryRun ? "tune-plan" : "tune";
        File.WriteAllText(Path.Combine(folder, stem + ".md"), md.ToString());
        File.WriteAllText(Path.Combine(folder, stem + ".json"), ToJson(new Dictionary<string, object> {
            { "scene", scene.path },
            { "changes", changes.Select(change => (object)new Dictionary<string, object> { { "kind", change.Kind }, { "path", change.Path }, { "before", change.Before }, { "after", change.After }, { "why", change.Why } }).ToList() },
            { "kept", kept.Select(change => (object)new Dictionary<string, object> { { "kind", change.Kind }, { "path", change.Path }, { "why", change.Why } }).ToList() } }, 0));

        var summary = new StringBuilder("tuned=" + scene.path + "\n");
        foreach (var group in changes.GroupBy(change => change.Kind)) summary.AppendLine("  " + group.Key + ": " + group.Count());
        foreach (var group in kept.GroupBy(change => change.Kind)) summary.AppendLine("  kept " + group.Key + ": " + group.Count());
        summary.AppendLine("needsBake=" + changes.Any(change => change.Kind != "Volume profile"));
        return summary.ToString();
    }

    /// <summary>
    /// Runtime point / spot lights that nothing in the browser drives become Baked: their direct light and shadows move
    /// into the lightmaps (static objects) and light probes (dynamic objects), and they cost nothing per frame. A light a
    /// web-side driver animates stays runtime, with its realtime shadows turned off.
    /// </summary>
    private static void TuneLights(Context context, TuneOptions options, List<Change> changes, List<Change> kept)
    {
        foreach (var light in context.Lights)
        {
            if (light.type != LightType.Point && light.type != LightType.Spot) continue;
            if (light.lightmapBakeType == LightmapBakeType.Baked) continue;
            string path = PathOf(light.transform);
            if (IsExcluded(light.transform, options.exclude) || MatchesName(light.name, options.keepLights)) { kept.Add(new Change { Kind = "light", Path = path, Why = "--keep-lights / --exclude" }); continue; }
            string webDriver = WebDriverOf(light.gameObject, context);
            bool shadowedKeyLight = light.shadows != LightShadows.None && !options.bakeShadowedLights;
            if (options.bakeLights && webDriver == null && !shadowedKeyLight)
            {
                string unityOnly = DriverOf(light.gameObject, context);
                if (!options.dryRun)
                {
                    var serialized = new SerializedObject(light);
                    serialized.FindProperty("m_Lightmapping").intValue = (int)LightmapBakeType.Baked;
                    serialized.ApplyModifiedPropertiesWithoutUndo();
                }
                changes.Add(new Change { Kind = "Light → Baked", Path = path, Before = light.type + " " + light.lightmapBakeType + ", shadows " + light.shadows, After = "Baked",
                    Why = "nothing in the browser animates it" + (unityOnly != null ? " (Unity-only: " + unityOnly + ")" : "") });
                FreeFromFixture(light, options, changes);
                continue;
            }
            if (options.pointSpotShadowsOff && light.shadows != LightShadows.None)
            {
                changes.Add(new Change { Kind = "Realtime shadows off", Path = path, Before = light.lightmapBakeType + ", shadows " + light.shadows, After = light.lightmapBakeType + ", shadows None",
                    Why = (webDriver != null ? "stays runtime (" + webDriver + ")" : "shadowed key light stays runtime so it lights what it lit in Unity (baking it changes occlusion; --bake-shadowed-lights to bake)")
                        + "; each shadowed light re-draws the scene every frame" });
                if (!options.dryRun) { light.shadows = LightShadows.None; EditorUtility.SetDirty(light); }
                continue;
            }
            kept.Add(new Change { Kind = "light", Path = path, Why = "runtime: " + (webDriver ?? "bakeLights off") });
        }
    }

    /// <summary>
    /// A light inside its own fixture (a lantern shell around the bulb) is lit fine in real time — the shadow map's near
    /// plane clips the shell — but the lightmapper traces from the bulb with no near plane, so a shadow-casting shell
    /// traps a baked light (Garden: lit floor under each lantern, dark walls and ceiling). The fixture's own renderers
    /// whose bounds hold the light stop casting shadows.
    /// </summary>
    private static void FreeFromFixture(Light light, TuneOptions options, List<Change> changes)
    {
        var fixture = PrefabUtility.GetOutermostPrefabInstanceRoot(light.gameObject);
        var root = fixture != null ? fixture.transform : light.transform.parent;
        if (root == null) return;
        var position = light.transform.position;
        foreach (var renderer in root.GetComponentsInChildren<MeshRenderer>(true))
        {
            if (renderer.shadowCastingMode == ShadowCastingMode.Off || renderer.shadowCastingMode == ShadowCastingMode.ShadowsOnly) continue;
            var bounds = renderer.bounds;
            bounds.Expand(2f * Mathf.Max(0.05f, light.shadowNearPlane));
            if (!bounds.Contains(position)) continue;
            changes.Add(new Change { Kind = "Fixture shadows off", Path = PathOf(renderer.transform), Before = "Cast Shadows " + renderer.shadowCastingMode, After = "Off",
                Why = "holds the baked light " + light.name + "; a shadow-casting shell traps a baked light (realtime shadows clipped it at the near plane)" });
            if (options.dryRun) continue;
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            EditorUtility.SetDirty(renderer);
        }
    }

    /// <summary>
    /// Renderers that are not static, but that nothing in the browser can move or toggle, get static flags so the
    /// exporter freezes their world matrices and they can be lightmapped and merged. Objects a script points at directly
    /// stay as they are (the script may move or toggle them in Unity).
    /// </summary>
    private static void MarkStatic(Context context, TuneOptions options, List<Change> changes, List<Change> kept)
    {
        foreach (var renderer in context.Renderers.OfType<MeshRenderer>())
        {
            var gameObject = renderer.gameObject;
            var flags = GameObjectUtility.GetStaticEditorFlags(gameObject);
            if (flags.HasFlag(StaticEditorFlags.ContributeGI) || flags.HasFlag(StaticEditorFlags.BatchingStatic)) continue;
            string path = PathOf(renderer.transform);
            if (IsExcluded(renderer.transform, options.exclude)) { kept.Add(new Change { Kind = "not static", Path = path, Why = "--exclude" }); continue; }
            string webDriver = WebDriverOf(gameObject, context);
            if (webDriver != null) { kept.Add(new Change { Kind = "not static", Path = path, Why = "moves in the browser: " + webDriver }); continue; }
            if (context.Referencers.TryGetValue(gameObject, out var referencers)) { kept.Add(new Change { Kind = "not static", Path = path, Why = "a script points at it: " + string.Join("/", referencers.Distinct().Take(3)) }); continue; }
            if (renderer.GetComponentInParent<ParticleSystem>() != null) { kept.Add(new Change { Kind = "not static", Path = path, Why = "part of a particle system" }); continue; }
            string notSurface = NotAVisibleSurface(renderer);
            if (notSurface != null) { kept.Add(new Change { Kind = "not static", Path = path, Why = notSurface }); continue; }

            var lod = renderer.GetComponentInParent<LODGroup>();
            int level = lod != null ? LodLevelOf(lod, renderer) : -1;
            bool lightmappable = level <= 0 && HasUV2(renderer) && VertexAnimationOf(renderer) == null && !IsTransparent(renderer);
            var newFlags = StaticEditorFlags.BatchingStatic | StaticEditorFlags.OccludeeStatic | StaticEditorFlags.OccluderStatic | StaticEditorFlags.ReflectionProbeStatic;
            if (lightmappable) newFlags |= StaticEditorFlags.ContributeGI;
            var receive = renderer.receiveGI;
            var newReceive = lightmappable || (level > 0 && HasUV2(renderer) && LodZeroIsLightmapped(lod)) ? ReceiveGI.Lightmaps : ReceiveGI.LightProbes;
            if (!options.dryRun)
            {
                GameObjectUtility.SetStaticEditorFlags(gameObject, newFlags);
                renderer.receiveGI = newReceive;
                EditorUtility.SetDirty(renderer);
            }
            changes.Add(new Change { Kind = "Marked static", Path = path, Before = "not static, " + receive, After = (lightmappable ? "static + ContributeGI, " : "static, ") + newReceive,
                Why = "nothing in the browser moves it" + (DriverOf(gameObject, context) is string unityOnly ? " (Unity-only: " + unityOnly + ")" : "") });
        }
    }

    /// <summary>
    /// Static renderers that are light-probe lit although they have lightmap UVs and no vertex animation switch to
    /// lightmaps (LOD0 contributes GI; lower levels borrow LOD0's lightmap). Lightmapped renderers can be merged; a
    /// merged probe-lit mesh would get one probe sample for its whole area.
    /// </summary>
    private static void LightmapProbeLit(Context context, TuneOptions options, List<Change> changes, List<Change> kept)
    {
        foreach (var renderer in context.Renderers.OfType<MeshRenderer>())
        {
            var flags = GameObjectUtility.GetStaticEditorFlags(renderer.gameObject);
            if (!flags.HasFlag(StaticEditorFlags.BatchingStatic) && !flags.HasFlag(StaticEditorFlags.ContributeGI)) continue;
            var lod = renderer.GetComponentInParent<LODGroup>();
            int level = lod != null ? LodLevelOf(lod, renderer) : -1;
            if (level > 0) continue;
            bool lightmapped = renderer.receiveGI == ReceiveGI.Lightmaps && flags.HasFlag(StaticEditorFlags.ContributeGI);
            if (lightmapped || renderer.lightProbeUsage == LightProbeUsage.Off) continue;
            string path = PathOf(renderer.transform);
            if (IsExcluded(renderer.transform, options.exclude)) continue;
            string reason = NotAVisibleSurface(renderer) ?? (!HasUV2(renderer) ? "no lightmap UVs (UV2)" : VertexAnimationOf(renderer) ?? (IsTransparent(renderer) ? "transparent" : null));
            if (reason != null) { kept.Add(new Change { Kind = "probe-lit", Path = path, Why = reason }); continue; }
            string before = (flags.HasFlag(StaticEditorFlags.ContributeGI) ? "ContributeGI, " : "no ContributeGI, ") + renderer.receiveGI;
            if (!options.dryRun)
            {
                GameObjectUtility.SetStaticEditorFlags(renderer.gameObject, flags | StaticEditorFlags.ContributeGI);
                renderer.receiveGI = ReceiveGI.Lightmaps;
                EditorUtility.SetDirty(renderer);
            }
            int lowerLevels = 0;
            if (lod != null)
            {
                var lods = lod.GetLODs();
                for (int i = 1; i < lods.Length; i++)
                    foreach (var lower in lods[i].renderers.OfType<MeshRenderer>())
                    {
                        if (!HasUV2(lower)) continue;
                        lowerLevels++;
                        if (options.dryRun) continue;
                        GameObjectUtility.SetStaticEditorFlags(lower.gameObject, GameObjectUtility.GetStaticEditorFlags(lower.gameObject) & ~StaticEditorFlags.ContributeGI | StaticEditorFlags.BatchingStatic);
                        lower.receiveGI = ReceiveGI.Lightmaps;
                        EditorUtility.SetDirty(lower);
                    }
            }
            changes.Add(new Change { Kind = "Probe-lit → lightmapped", Path = path, Before = before, After = "ContributeGI, Lightmaps" + (lowerLevels > 0 ? " (+" + lowerLevels + " lower LOD renderers share LOD0's lightmap)" : ""),
                Why = "static with lightmap UVs; lightmapped meshes can merge" });
        }
    }

    /// <summary>
    /// A motion blur override with intensity 0 does nothing in Unity (MotionBlur.IsActive() is false), but older
    /// toolkit runtimes still build a motion blur post-process and the buffers it needs. Deactivating the override
    /// changes nothing in Unity. The profile is a project asset: the change is recorded for undo.
    /// </summary>
    private static void FixZeroMotionBlur(Context context, List<Change> changes, bool dryRun)
    {
        var profiles = new HashSet<VolumeProfile>(context.All<Volume>().Select(volume => volume.sharedProfile).Where(profile => profile != null));
        var manager = VolumeManager.instance;
        foreach (var name in new[] { "globalDefaultProfile", "qualityDefaultProfile" })
            if (typeof(VolumeManager).GetProperty(name)?.GetValue(manager) is VolumeProfile profile) profiles.Add(profile);
        foreach (var profile in profiles)
            foreach (var component in profile.components)
            {
                if (component == null || !component.active || component.GetType().Name != "MotionBlur") continue;
                var field = component.GetType().GetField("intensity");
                if (!(field?.GetValue(component) is VolumeParameter parameter)) continue;
                float intensity = Convert.ToSingle(parameter.GetType().GetProperty("value").GetValue(parameter));
                if (intensity > 0f) continue;
                if (!dryRun)
                {
                    component.active = false;
                    EditorUtility.SetDirty(component);
                    EditorUtility.SetDirty(profile);
                }
                changes.Add(new Change { Kind = "Volume profile", Path = AssetDatabase.GetAssetPath(profile) + " MotionBlur", Before = "active, intensity 0", After = "inactive",
                    Why = "intensity 0 is off in Unity; the browser still built the effect (project asset — undo: re-tick the override)" });
            }
    }

    /// <summary>
    /// Opens the scene (discarding nothing: refuses when the open scene has unsaved changes) and places a capture camera
    /// named "BtOptimizePoseCamera" at a pose recorded by the browser profiler (toolkit scenes keep Unity's coordinates),
    /// copying the main camera's settings and URP data so post-processing matches. Capture it with
    /// `capture_game_view --camera BtOptimizePoseCamera`. The camera is never saved: reopening the scene removes it.
    /// </summary>
    public static string PoseView(string scenePath, float px, float py, float pz, float qx, float qy, float qz, float qw, float verticalFovRadians)
    {
        var active = SceneManager.GetActiveScene();
        if (active.path != scenePath)
        {
            // The only unsaved change PoseView allows itself to discard is its own pose camera.
            bool onlyPoseCamera = active.GetRootGameObjects().Any(root => root.name == "BtOptimizePoseCamera");
            if (active.isDirty && !onlyPoseCamera) throw new InvalidOperationException("'" + active.path + "' has unsaved changes; save or discard them first.");
            EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
        }
        var scene = SceneManager.GetActiveScene();
        var existing = scene.GetRootGameObjects().FirstOrDefault(root => root.name == "BtOptimizePoseCamera");
        if (existing != null) UnityEngine.Object.DestroyImmediate(existing);
        var main = Camera.main;
        var go = new GameObject("BtOptimizePoseCamera");
        var camera = go.AddComponent<Camera>();
        if (main != null)
        {
            camera.CopyFrom(main);
            var mainData = main.GetComponents<Component>().FirstOrDefault(c => c != null && c.GetType().Name == "UniversalAdditionalCameraData");
            if (mainData != null)
            {
                var data = go.GetComponent(mainData.GetType()) ?? go.AddComponent(mainData.GetType());
                EditorUtility.CopySerialized(mainData, data);
            }
            main.enabled = false;
        }
        go.transform.SetPositionAndRotation(new Vector3(px, py, pz), new Quaternion(qx, qy, qz, qw));
        camera.fieldOfView = verticalFovRadians * Mathf.Rad2Deg;
        camera.enabled = true;
        return "pose camera at " + go.transform.position.ToString("F2") + " fov " + camera.fieldOfView.ToString("F1") + " in " + scene.path;
    }

    /// <summary>
    /// Opt-in, project-wide exporter settings (they change every scene's export). `textures`: "ktx2" (KTX2 / UASTC:
    /// ~4-8x less GPU memory, slower export) or "keep"; `resolution`: "css" (render at CSS pixels on desktop - a quarter
    /// of the pixels on a 2x screen; helps only a GPU-bound scene) or "keep". Previous values are appended to
    /// .agents/optimize/exporter-settings-undo.txt.
    /// </summary>
    public static string ExporterSettings(string textures, string resolution)
    {
        var info = CanvasToolsInfo.Instance;
        var log = new StringBuilder();
        if (textures == "ktx2" && info.TextureImageFormat != 3)
        {
            log.AppendLine("TextureImageFormat " + info.TextureImageFormat + " -> 3 (KTX2)");
            info.TextureImageFormat = 3;
        }
        if (resolution == "css" && info.AdaptToDeviceRatio != -1)
        {
            log.AppendLine("AdaptToDeviceRatio " + info.AdaptToDeviceRatio + " -> -1 (CSS pixels)");
            info.AdaptToDeviceRatio = -1;
        }
        if (log.Length == 0) return "exporter settings unchanged";
        CanvasToolsInfo.SaveSettings();
        string folder = Path.Combine(Path.GetDirectoryName(Application.dataPath), ".agents", "optimize");
        Directory.CreateDirectory(folder);
        File.AppendAllText(Path.Combine(folder, "exporter-settings-undo.txt"), DateTime.Now.ToString("yyyy-MM-dd HH:mm") + "\n" + log);
        return log.ToString();
    }

    /// <summary>
    /// Names what can move, toggle or animate the object in the browser: toolkit script components (EditorScriptComponent),
    /// Animator / Animation, Timeline bindings, physics bodies, navigation agents and constraints — on the object or an
    /// ancestor — and toolkit script components that point at it. Unity-only MonoBehaviours do not run in the browser.
    /// </summary>
    private static string WebDriverOf(GameObject gameObject, Context context)
    {
        for (var node = gameObject.transform; node != null; node = node.parent)
        {
            string where = node == gameObject.transform ? "" : " on " + node.name;
            foreach (var component in node.GetComponents<Component>())
            {
                if (component == null) continue;
                if (component is EditorScriptComponent) return "script " + component.GetType().Name + where;
                if (component is Animator || component is Animation || component is Rigidbody || component is CharacterController
                    || component is UnityEngine.AI.NavMeshAgent || component is UnityEngine.Animations.IConstraint)
                    return component.GetType().Name + where;
            }
            if (context.TimelineBound.Contains(node.gameObject)) return "Timeline binding" + where;
            if (context.WebReferencers.TryGetValue(node.gameObject, out var scripts)) return "referenced by " + string.Join("/", scripts.Distinct().Take(2)) + where;
        }
        return null;
    }

    /// <summary>Why the renderer's shaders move vertices (wind, vertex animation), or null.</summary>
    private static string VertexAnimationOf(Renderer renderer)
    {
        foreach (var material in renderer.sharedMaterials)
        {
            if (material == null || material.shader == null) continue;
            string path = AssetDatabase.GetAssetPath(material.shader);
            if (!path.EndsWith(".shadergraph")) continue;
            if (!s_VertexAnimation.TryGetValue(path, out var verdict))
                s_VertexAnimation[path] = verdict = GraphMovesVertices(File.ReadAllText(path)) ? "Shader Graph moves vertices (" + material.shader.name + ")" : null;
            if (verdict != null) return verdict;
        }
        return null;
    }

    private static readonly Dictionary<string, string> s_VertexAnimation = new Dictionary<string, string>();

    /// <summary>True when something is wired into the graph's vertex Position block (same scan as the merge stage).</summary>
    private static bool GraphMovesVertices(string graphText)
    {
        var objectId = new System.Text.RegularExpressions.Regex("\"m_ObjectId\":\\s*\"([0-9a-f]+)\"");
        foreach (var chunk in graphText.Split(new[] { "\n}\n" }, StringSplitOptions.None))
        {
            if (!chunk.Contains("\"m_SerializedDescriptor\": \"VertexDescription.Position\"")) continue;
            var blockId = objectId.Match(chunk);
            if (blockId.Success && System.Text.RegularExpressions.Regex.IsMatch(graphText, "\"m_InputSlot\":\\s*\\{\\s*\"m_Node\":\\s*\\{\\s*\"m_Id\":\\s*\"" + blockId.Groups[1].Value + "\"")) return true;
        }
        return false;
    }

    /// <summary>
    /// Why the renderer is not a visible, lightmappable surface, or null. Only shaders with a lightmapper Meta pass
    /// (URP Lit / Simple Lit / Unlit, Built-in Standard, Shader Graph Lit / Unlit…) describe a surface to the bake.
    /// Stencil masks, depth-only and other utility shaders have none — marked Contribute GI, Garden's invisible
    /// `Room1Screens` stencil mesh (Custom/StencilOnly, wrapping a whole room) became a solid box in the bake and the
    /// room went dark.
    /// </summary>
    private static string NotAVisibleSurface(Renderer renderer)
    {
        foreach (var material in renderer.sharedMaterials)
        {
            if (material == null || material.shader == null) return "missing material or shader";
            var shader = material.shader;
            // URP / Shader Graph tag the pass LightMode "META"; compare case-insensitively, and accept a pass named Meta.
            bool hasMeta = material.FindPass("Meta") >= 0;
            for (int pass = 0; pass < shader.passCount && !hasMeta; pass++)
                hasMeta = string.Equals(shader.FindPassTagValue(pass, new ShaderTagId("LightMode")).name, "Meta", StringComparison.OrdinalIgnoreCase);
            if (!hasMeta) return "not a visible surface for the lightmapper (" + shader.name + " has no Meta pass: stencil / depth / utility shader)";
        }
        return null;
    }

    private static bool HasUV2(Renderer renderer)
    {
        var filter = renderer.GetComponent<MeshFilter>();
        return filter != null && filter.sharedMesh != null && filter.sharedMesh.HasVertexAttribute(VertexAttribute.TexCoord1);
    }

    private static bool IsTransparent(Renderer renderer)
    {
        return renderer.sharedMaterials.Any(material => material != null && material.renderQueue >= FirstTransparentQueue);
    }

    private static bool LodZeroIsLightmapped(LODGroup lod)
    {
        var lods = lod.GetLODs();
        return lods.Length > 0 && lods[0].renderers.OfType<MeshRenderer>().Any(renderer => renderer.receiveGI == ReceiveGI.Lightmaps
            && GameObjectUtility.GetStaticEditorFlags(renderer.gameObject).HasFlag(StaticEditorFlags.ContributeGI));
    }

    private static bool MatchesName(string name, string[] patterns)
    {
        return patterns != null && patterns.Any(pattern => pattern.EndsWith("*") ? name.StartsWith(pattern.TrimEnd('*')) : name == pattern);
    }

    private static bool IsExcluded(Transform transform, string[] patterns)
    {
        for (var node = transform; node != null; node = node.parent) if (MatchesName(node.name, patterns)) return true;
        return false;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------------------------

    /// <summary>Everything the survey needs about the scene, gathered once.</summary>
    private sealed class Context
    {
        public readonly Scene Scene;
        public readonly List<GameObject> Roots;
        public readonly List<Light> Lights;
        public readonly List<Renderer> Renderers;
        public readonly Dictionary<GameObject, List<string>> Referencers;
        public readonly HashSet<GameObject> TimelineBound;
        /// <summary>Objects that toolkit script components (which run in the browser) point at.</summary>
        public readonly Dictionary<GameObject, List<string>> WebReferencers;
        public readonly StringBuilder Summary = new StringBuilder();

        public Context(Scene scene)
        {
            Scene = scene;
            Roots = scene.GetRootGameObjects().ToList();
            Lights = All<Light>().Where(light => light.isActiveAndEnabled).ToList();
            Renderers = All<Renderer>().Where(renderer => renderer.enabled && renderer.gameObject.activeInHierarchy && (renderer is MeshRenderer || renderer is SkinnedMeshRenderer)).ToList();
            Referencers = CollectReferencers(Roots, false);
            WebReferencers = CollectReferencers(Roots, true);
            TimelineBound = CollectTimelineBindings(Roots);
        }

        /// <summary>Every component of type T in the scene, including inactive objects.</summary>
        public IEnumerable<T> All<T>() where T : Component
        {
            return Roots.SelectMany(root => root.GetComponentsInChildren<T>(true));
        }
    }

    /// <summary>A set of renderers that share a prefab / mesh key, with one example note.</summary>
    private sealed class Group
    {
        public int Count;
        public readonly List<string> Paths = new List<string>();
        public readonly Dictionary<string, int> Notes = new Dictionary<string, int>();
    }

    private static void Add(Dictionary<string, Group> groups, string key, Renderer renderer, string note)
    {
        if (!groups.TryGetValue(key, out var group)) groups[key] = group = new Group();
        group.Count++;
        if (group.Paths.Count < 3) group.Paths.Add(PathOf(renderer.transform));
        group.Notes[note] = group.Notes.TryGetValue(note, out var count) ? count + 1 : 1;
    }

    private static void WriteGroups(StringBuilder md, string title, Dictionary<string, Group> groups)
    {
        md.AppendLine("### " + title + " — " + groups.Values.Sum(group => group.Count) + " renderers in " + groups.Count + " groups");
        md.AppendLine();
        if (groups.Count == 0) { md.AppendLine("None."); md.AppendLine(); return; }
        md.AppendLine("| Group | Count | Why / notes | Example |");
        md.AppendLine("|---|---|---|---|");
        foreach (var pair in groups.OrderByDescending(pair => pair.Value.Count))
            md.AppendLine("| " + pair.Key + " | " + pair.Value.Count + " | " + string.Join("; ", pair.Value.Notes.OrderByDescending(note => note.Value).Select(note => note.Key + " ×" + note.Value)) + " | " + pair.Value.Paths.First() + " |");
        md.AppendLine();
    }

    private static List<object> GroupsToJson(Dictionary<string, Group> groups)
    {
        return groups.OrderByDescending(pair => pair.Value.Count).Select(pair => (object)new Dictionary<string, object> {
            { "key", pair.Key }, { "count", pair.Value.Count }, { "notes", pair.Value.Notes.Select(note => (object)(note.Key + " x" + note.Value)).ToList() },
            { "examples", pair.Value.Paths.Cast<object>().ToList() } }).ToList();
    }

    /// <summary>Groups renderers by their nearest prefab instance root name, or by mesh name.</summary>
    private static string GroupKey(Renderer renderer)
    {
        var root = PrefabUtility.GetOutermostPrefabInstanceRoot(renderer.gameObject);
        if (root != null) return StripCopySuffix(root.name);
        var filter = renderer.GetComponent<MeshFilter>();
        return filter != null && filter.sharedMesh != null ? "mesh " + filter.sharedMesh.name : StripCopySuffix(renderer.name);
    }

    private static string StripCopySuffix(string name)
    {
        int index = name.IndexOf(" (", StringComparison.Ordinal);
        return index > 0 ? name.Substring(0, index) : name;
    }

    /// <summary>What a probe-lit renderer would need to become lightmapped.</summary>
    private static string ProbeLitNote(Renderer renderer, StaticEditorFlags flags, int lodLevel)
    {
        var filter = renderer.GetComponent<MeshFilter>();
        bool uv2 = filter != null && filter.sharedMesh != null && filter.sharedMesh.HasVertexAttribute(VertexAttribute.TexCoord1);
        string gi = flags.HasFlag(StaticEditorFlags.ContributeGI) ? "ContributeGI" : "no ContributeGI";
        string receive = renderer is MeshRenderer meshRenderer ? "receive " + meshRenderer.receiveGI : "skinned";
        return gi + ", " + receive + ", " + (uv2 ? "has UV2" : "NO UV2") + (lodLevel == 0 ? ", LOD0" : "");
    }

    private static int LodLevelOf(LODGroup lodGroup, Renderer renderer)
    {
        var lods = lodGroup.GetLODs();
        for (int i = 0; i < lods.Length; i++) if (lods[i].renderers.Contains(renderer)) return i;
        return -1;
    }

    /// <summary>
    /// Names what can move, toggle or animate the object at runtime: scripts, Animator / Animation, Rigidbody,
    /// timeline bindings and serialized references (on the object or any ancestor). Null when nothing does.
    /// </summary>
    private static string DriverOf(GameObject gameObject, Context context)
    {
        var reasons = new List<string>();
        for (var node = gameObject.transform; node != null; node = node.parent)
        {
            string where = node == gameObject.transform ? "" : " on " + node.name;
            foreach (var behaviour in node.GetComponents<MonoBehaviour>())
                if (behaviour != null && !IsPassiveComponent(behaviour)) reasons.Add("script " + behaviour.GetType().Name + where);
            if (node.GetComponent<Animator>() != null) reasons.Add("Animator" + where);
            if (node.GetComponent<Animation>() != null) reasons.Add("Animation" + where);
            if (node.GetComponent<Rigidbody>() != null) reasons.Add("Rigidbody" + where);
            if (context.TimelineBound.Contains(node.gameObject)) reasons.Add("Timeline binding" + where);
            if (context.Referencers.TryGetValue(node.gameObject, out var referencers)) reasons.Add("referenced by " + string.Join("/", referencers.Distinct().Take(3)) + where);
            if (reasons.Count >= 3) break;
        }
        return reasons.Count > 0 ? string.Join(", ", reasons.Distinct().Take(3)) : null;
    }

    /// <summary>Components that never move or toggle their object (data-only toolkit or Unity helpers).</summary>
    private static bool IsPassiveComponent(MonoBehaviour behaviour)
    {
        string name = behaviour.GetType().Name;
        return name == "UniversalAdditionalLightData" || name == "UniversalAdditionalCameraData" || name == "MeshCombinerSettings"
            || name == "LightSettings" || name == "AdditionalTags";
    }

    /// <summary>For every GameObject a serialized field points at: the types of the components pointing at it.</summary>
    private static Dictionary<GameObject, List<string>> CollectReferencers(List<GameObject> roots, bool webScriptsOnly)
    {
        var result = new Dictionary<GameObject, List<string>>();
        foreach (var root in roots)
            foreach (var component in root.GetComponentsInChildren<Component>(true))
            {
                if (component == null || component is Transform || component is MeshFilter || component is Renderer || component is LODGroup) continue;
                if (component is MonoBehaviour behaviour && IsPassiveComponent(behaviour)) continue;
                if (webScriptsOnly && !(component is EditorScriptComponent)) continue;
                var property = new SerializedObject(component).GetIterator();
                while (property.Next(true))
                {
                    if (property.propertyType != SerializedPropertyType.ObjectReference) continue;
                    var value = property.objectReferenceValue;
                    var target = value as GameObject ?? (value as Component)?.gameObject;
                    if (target == null || target == component.gameObject || !target.scene.IsValid()) continue;
                    if (!result.TryGetValue(target, out var list)) result[target] = list = new List<string>();
                    list.Add(component.GetType().Name);
                }
            }
        return result;
    }

    /// <summary>Every GameObject bound to a track of a PlayableDirector in the scene.</summary>
    private static HashSet<GameObject> CollectTimelineBindings(List<GameObject> roots)
    {
        var bound = new HashSet<GameObject>();
        foreach (var root in roots)
            foreach (var director in root.GetComponentsInChildren<UnityEngine.Playables.PlayableDirector>(true))
            {
                if (director.playableAsset == null) continue;
                foreach (var output in director.playableAsset.outputs)
                {
                    var binding = output.sourceObject != null ? director.GetGenericBinding(output.sourceObject) : null;
                    var target = binding as GameObject ?? (binding as Component)?.gameObject;
                    if (target != null) bound.Add(target);
                }
            }
        return bound;
    }

    /// <summary>True when the light's range reaches the renderer's bounds (directional lights reach everything).</summary>
    private static bool Reaches(Light light, Renderer renderer)
    {
        return light.type == LightType.Directional || renderer.bounds.SqrDistance(light.transform.position) <= light.range * light.range;
    }

    private static string EnumName(SerializedProperty property)
    {
        if (property == null) return "";
        return property.propertyType == SerializedPropertyType.Enum && property.enumValueIndex >= 0 && property.enumValueIndex < property.enumNames.Length
            ? property.enumNames[property.enumValueIndex] : property.intValue.ToString();
    }

    private static object PropertyValue(SerializedProperty property)
    {
        switch (property.propertyType)
        {
            case SerializedPropertyType.Boolean: return property.boolValue;
            case SerializedPropertyType.Float: return property.floatValue;
            case SerializedPropertyType.Integer: return property.intValue;
            case SerializedPropertyType.Enum: return EnumName(property);
            default: return property.propertyType.ToString();
        }
    }

    private static string FormatValue(object value)
    {
        if (value == null) return "null";
        if (value is float number) return number.ToString("0.###");
        if (value is UnityEngine.Object asset) return asset.name;
        return value.ToString();
    }

    private static string PathOf(Transform transform)
    {
        var parts = new List<string>();
        for (var node = transform; node != null; node = node.parent) parts.Insert(0, node.name);
        return string.Join("/", parts);
    }

    private static string ReportFolder(Scene scene)
    {
        string folder = Path.Combine(Path.GetDirectoryName(Application.dataPath), ".agents", "optimize", scene.name);
        Directory.CreateDirectory(folder);
        return folder;
    }

    /// <summary>Minimal JSON writer for dictionaries, lists, strings, numbers and booleans.</summary>
    private static string ToJson(object value, int depth)
    {
        string indent = new string(' ', depth * 2), inner = new string(' ', (depth + 1) * 2);
        switch (value)
        {
            case null: return "null";
            case string text: return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n") + "\"";
            case bool flag: return flag ? "true" : "false";
            case float number: return number.ToString(System.Globalization.CultureInfo.InvariantCulture);
            case double number: return number.ToString(System.Globalization.CultureInfo.InvariantCulture);
            case int or long: return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
            case Dictionary<string, object> map:
                return "{\n" + string.Join(",\n", map.Select(pair => inner + ToJson(pair.Key, 0) + ": " + ToJson(pair.Value, depth + 1))) + "\n" + indent + "}";
            case System.Collections.IEnumerable list:
                var items = list.Cast<object>().Select(item => inner + ToJson(item, depth + 1)).ToList();
                return items.Count == 0 ? "[]" : "[\n" + string.Join(",\n", items) + "\n" + indent + "]";
            default: return ToJson(value.ToString(), depth);
        }
    }
}
