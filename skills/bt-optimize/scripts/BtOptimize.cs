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

    /// <summary>A rigid skinned mesh keeps its own mesh when its bind pose moves no vertex by more than this many units.</summary>
    private const float RestPoseToleranceUnits = 0.01f;

    /// <summary>The rest-pose tolerance as a share of the mesh's size, for meshes too large for the fixed tolerance.</summary>
    private const float RestPoseRelativeTolerance = 0.0005f;

    /// <summary>Skinning verdict: one bone that moves with the object — converts to MeshFilter + MeshRenderer.</summary>
    private const string SkinRigid = "rigid — needs no skinning";

    /// <summary>
    /// Skinning verdict: rigid, but its bind pose places the mesh away from its object — converts to a plain mesh with
    /// that fixed offset baked in, one mesh asset shared by every copy with the same offset (so they still instance).
    /// </summary>
    private const string SkinRigidOffset = "rigid — needs no skinning (offset baked)";

    /// <summary>Offset matrices and baked pose vertices are compared at this precision when copies share one baked mesh.</summary>
    private const int SharedMeshKeyDecimals = 4;

    /// <summary>
    /// Skinning verdict: one bone, and the only thing that seemed to move it apart from the object is a toolkit script
    /// on the renderer's own object — converts to a plain mesh baked as it is drawn now (the script stays).
    /// </summary>
    private const string SkinRigidScriptHost = "rigid — a script sits on the object; Tune bakes it in place";

    /// <summary>
    /// Skinning verdict: rigid, but a clip animates the SkinnedMeshRenderer itself — converts like a rigid mesh, and the
    /// clip is copied with those curves aimed at MeshRenderer, on a copy of the Animator's controller.
    /// </summary>
    private const string SkinRigidRendererCurves = "rigid — Tune retargets its renderer curves";

    /// <summary>
    /// Skinning verdict: rigid, but converting would change it — its bone moves apart from the object (a clip, Timeline,
    /// constraint or physics body), a component references the SkinnedMeshRenderer, or a clip Tune cannot retarget (a
    /// legacy Animation, an override controller) animates it.
    /// </summary>
    private const string SkinRigidByHand = "rigid — convert by hand";

    /// <summary>
    /// Skinning verdict: several weighted bones that nothing moves apart from the object — the pose never changes. Tune
    /// bakes the pose to a static mesh, copies with the same pose sharing one mesh asset.
    /// </summary>
    private const string SkinFrozenPose = "frozen pose — bake to a static mesh";

    /// <summary>Skinning verdict: really deforms (animated bones, blend shapes or cloth).</summary>
    private const string SkinDeforms = "deforms — really skinned";

    /// <summary>Why --keep-gi leaves an object out of the bake (see TuneOptions.keepSourceGI).</summary>
    private const string KeepGIReason = "keep-gi: not a GI contributor in the source";

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
        SurveySkinning(context, md, json);
        SurveyRepeats(context, md, json);
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

    /// <summary>
    /// Every skinned renderer and whether it really needs skinning. A skinned mesh in BabylonJS is skinned every frame,
    /// and copies of one that animate separately can never share an instanced draw: each copy is its own draw in every
    /// pass. DAE / FBX imports often make rigid props (coins, item boxes, trees, signs) one-bone skinned meshes that
    /// bought nothing — those convert to MeshFilter + MeshRenderer (Tune `unskinRigid`).
    /// </summary>
    private static void SurveySkinning(Context context, StringBuilder md, Dictionary<string, object> json)
    {
        var rows = new List<object>();
        var verdictCounts = new Dictionary<string, int>();
        md.AppendLine("## Skinned meshes — which ones need skinning");
        md.AppendLine();
        var skinnedRenderers = context.Renderers.OfType<SkinnedMeshRenderer>().ToList();
        if (skinnedRenderers.Count == 0) { md.AppendLine("None."); md.AppendLine(); json["skinning"] = rows; return; }
        md.AppendLine("| Mesh | Copies | Verdict | Why | Next step | Example |");
        md.AppendLine("|---|---|---|---|---|---|");
        var groups = skinnedRenderers.Select(renderer => new { renderer, verdict = ClassifySkinning(renderer, context) })
            .GroupBy(entry => (entry.renderer.sharedMesh != null ? entry.renderer.sharedMesh.name : "none") + "|" + entry.verdict.Kind)
            .OrderByDescending(group => group.Count());
        foreach (var group in groups)
        {
            var first = group.First();
            int copies = group.Count();
            string nextStep = NextStepForSkinning(first.verdict.Kind, copies);
            verdictCounts[first.verdict.Kind] = verdictCounts.TryGetValue(first.verdict.Kind, out var count) ? count + copies : copies;
            string meshName = first.renderer.sharedMesh != null ? first.renderer.sharedMesh.name : "none";
            md.AppendLine("| " + meshName + " | " + copies + " | " + first.verdict.Kind + " | " + first.verdict.Why + " | " + nextStep + " | " + PathOf(first.renderer.transform) + " |");
            rows.Add(new Dictionary<string, object> { { "mesh", meshName }, { "copies", copies }, { "verdict", first.verdict.Kind }, { "why", first.verdict.Why },
                { "nextStep", nextStep }, { "example", PathOf(first.renderer.transform) } });
        }
        md.AppendLine();
        md.AppendLine("Skinned renderers: **" + skinnedRenderers.Count + "** — " + string.Join(", ", verdictCounts.Select(pair => pair.Key + " " + pair.Value)) + ".");
        md.AppendLine();
        context.Summary.AppendLine("skinned=" + skinnedRenderers.Count + " " + string.Join(" ", verdictCounts.Select(pair => "[" + pair.Key + "]=" + pair.Value)));
        json["skinning"] = rows;
    }

    /// <summary>What to do about a group of skinned renderers with the given verdict.</summary>
    private static string NextStepForSkinning(string verdictKind, int copies)
    {
        if (verdictKind == SkinRigid) return "Tune converts it (unskinRigid)";
        if (verdictKind == SkinRigidOffset) return "Tune converts it to a shared baked mesh (unskinRigid)";
        if (verdictKind == SkinRigidScriptHost) return "Tune bakes it to a plain mesh in place (unskinRigid)";
        if (verdictKind == SkinRigidRendererCurves) return "Tune converts it and retargets the clip to MeshRenderer (unskinRigid)";
        if (verdictKind == SkinRigidByHand) return "convert by hand (see Why), then re-survey";
        if (verdictKind == SkinFrozenPose) return "Tune bakes it to a static mesh";
        return copies > 1 ? "repeated deforming mesh: candidate for the toolkit AnimatorControlRig VAT (crowd) mode — instanced, one draw" : "keep";
    }

    /// <summary>
    /// Every mesh drawn more than once with the same materials, and whether its copies can share one instanced draw in
    /// BabylonJS. The exporter writes repeated meshes as glTF instances (ExportMeshInstances), but never skinned or
    /// lightmapped copies, and a material splits into copies per reflection probe. Repeated props are usually the
    /// largest group of draws in a level after the level geometry itself.
    /// </summary>
    private static void SurveyRepeats(Context context, StringBuilder md, Dictionary<string, object> json)
    {
        var rows = new List<object>();
        md.AppendLine("## Repeated meshes — do the copies share one draw?");
        md.AppendLine();
        md.AppendLine("| Mesh | Copies | Draws now (est.) | Draws if instanced | What stops sharing | Example |");
        md.AppendLine("|---|---|---|---|---|---|");
        int drawsNow = 0, drawsInstanced = 0;
        var repeated = context.Renderers.GroupBy(RepeatKey).Where(group => group.Count() > 1).OrderByDescending(group => group.Count() * SubMeshCount(group.First()));
        foreach (var group in repeated)
        {
            var renderers = group.ToList();
            int subMeshes = SubMeshCount(renderers[0]);
            var blockers = InstancingBlockers(renderers, context);
            int probeZones = renderers.Select(DominantReflectionProbe).Distinct().Count();
            int groupDrawsNow = blockers.Count == 0 ? subMeshes * probeZones : subMeshes * renderers.Count;
            drawsNow += groupDrawsNow;
            drawsInstanced += subMeshes * probeZones;
            string meshName = MeshOf(renderers[0]) != null ? MeshOf(renderers[0]).name : renderers[0].name;
            string blockerText = blockers.Count == 0 ? (probeZones > 1 ? "shares (one draw per reflection probe zone: " + probeZones + ")" : "shares one draw") : string.Join("; ", blockers);
            md.AppendLine("| " + meshName + " | " + renderers.Count + " | " + groupDrawsNow + " | " + subMeshes * probeZones + " | " + blockerText + " | " + PathOf(renderers[0].transform) + " |");
            rows.Add(new Dictionary<string, object> { { "mesh", meshName }, { "copies", renderers.Count }, { "drawsNow", groupDrawsNow }, { "drawsIfInstanced", subMeshes * probeZones },
                { "blockers", blockers.Cast<object>().ToList() }, { "example", PathOf(renderers[0].transform) } });
        }
        md.AppendLine();
        md.AppendLine("Repeated-mesh draws (one pass, all copies in view): **" + drawsNow + "** now, **" + drawsInstanced + "** if every group shared its draw.");
        md.AppendLine();
        context.Summary.AppendLine("repeatedDraws now=" + drawsNow + " instanced=" + drawsInstanced);
        json["repeats"] = new Dictionary<string, object> { { "drawsNow", drawsNow }, { "drawsIfInstanced", drawsInstanced }, { "groups", rows } };
    }

    /// <summary>Why copies of one mesh cannot share an instanced draw in BabylonJS (empty when they can).</summary>
    private static List<string> InstancingBlockers(List<Renderer> renderers, Context context)
    {
        var blockers = new List<string>();
        var skinned = renderers.OfType<SkinnedMeshRenderer>().ToList();
        if (skinned.Count > 0)
        {
            string verdict = ClassifySkinning(skinned[0], context).Kind;
            blockers.Add("skinned ×" + skinned.Count + " (" + verdict + ")");
        }
        int lightmapped = renderers.OfType<MeshRenderer>().Count(renderer => renderer.receiveGI == ReceiveGI.Lightmaps
            && GameObjectUtility.GetStaticEditorFlags(renderer.gameObject).HasFlag(StaticEditorFlags.ContributeGI));
        if (lightmapped > 0) blockers.Add("lightmapped ×" + lightmapped + " (each lightmapped copy is exported as its own mesh)");
        return blockers;
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
        /// <summary>
        /// Replace SkinnedMeshRenderers that need no skinning (one weighted bone moving with the object, no blend shapes
        /// or cloth, rest pose equal to the mesh) with MeshFilter + MeshRenderer on the same mesh and materials. Animators
        /// stay: transform, child and collider curves keep working. Runs first, so the other steps see the new renderers.
        /// </summary>
        public bool unskinRigid = true;
        /// <summary>
        /// A mesh drawn this many times or more (same mesh and materials) is not lightmapped (lightmapped copies never
        /// share), and its copies get Light Probe Usage Off so they share one instanced draw: the toolkit loads every
        /// probe-lit node as its own mesh (SceneManager.DeinstanceProbeLitNodes). 0 turns the rule off.
        /// </summary>
        public int instanceRepeatsFrom = 4;
        /// <summary>
        /// Keep Contribute GI exactly as the source scene has it (the source named in working-copy.txt): no step adds
        /// Contribute GI to an object that did not contribute in the source, so the re-bake keeps the source's indirect
        /// light. Off by default, because merging needs the newly lightmapped props.
        /// </summary>
        public bool keepSourceGI = false;
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
        var sourceGIContributors = SourceGIContributorsOf(scene, folder);
        var context = new Context(scene, sourceGIContributors);
        var changes = new List<Change>();
        var kept = new List<Change>();

        if (options.unskinRigid)
        {
            int converted = UnskinRigid(context, options, changes, kept);
            // The converted objects now have MeshRenderers: gather the scene again so the static and lightmap steps see them.
            if (converted > 0 && !options.dryRun) context = new Context(scene, sourceGIContributors);
        }
        if (options.bakeLights || options.pointSpotShadowsOff) TuneLights(context, options, changes, kept);
        if (options.markStatic) MarkStatic(context, options, changes, kept);
        if (options.lightmapProbeLit) LightmapProbeLit(context, options, changes, kept);
        if (options.instanceRepeatsFrom > 0) InstanceRepeats(context, options, changes, kept);
        if (options.fixZeroMotionBlur) FixZeroMotionBlur(context, changes, options.dryRun);
        // A dry run changed no flags, so its copy count is the one the planned changes would leave.
        int copyGIContributors = options.dryRun ? context.PlannedGIContributors.Count : GIContributorPaths(scene.GetRootGameObjects()).Count;
        string giContributorsLine = "GI contributors: source " + sourceGIContributors.Count + " → copy " + copyGIContributors
            + (options.keepSourceGI ? " (--keep-gi)" : "");

        if (!options.dryRun)
        {
            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene);
            AssetDatabase.SaveAssets();
        }

        var md = new StringBuilder("# bt-optimize tune" + (options.dryRun ? " plan (dry run — nothing changed)" : "") + " — " + scene.path + "\n\n");
        md.AppendLine(giContributorsLine + "\n");
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
            { "giContributors", new Dictionary<string, object> { { "source", sourceGIContributors.Count }, { "copy", copyGIContributors }, { "keepSourceGI", options.keepSourceGI } } },
            { "changes", changes.Select(change => (object)new Dictionary<string, object> { { "kind", change.Kind }, { "path", change.Path }, { "before", change.Before }, { "after", change.After }, { "why", change.Why } }).ToList() },
            { "kept", kept.Select(change => (object)new Dictionary<string, object> { { "kind", change.Kind }, { "path", change.Path }, { "why", change.Why } }).ToList() } }, 0));

        var summary = new StringBuilder("tuned=" + scene.path + "\n");
        foreach (var group in changes.GroupBy(change => change.Kind)) summary.AppendLine("  " + group.Key + ": " + group.Count());
        foreach (var group in kept.GroupBy(change => change.Kind)) summary.AppendLine("  kept " + group.Key + ": " + group.Count());
        summary.AppendLine(giContributorsLine);
        summary.AppendLine("needsBake=" + changes.Any(change => change.Kind != "Volume profile"));
        return summary.ToString();
    }

    /// <summary>
    /// Replaces every skinned renderer that needs no skinning with a MeshFilter + MeshRenderer. An Animator on the object
    /// is not a reason to skip it: Animators that move, scale or toggle the object (spawn pops, spins, bobs) keep working
    /// on a plain mesh. One-bone props keep their mesh (or a shared offset-baked copy); a script host and a frozen pose
    /// are baked as they are drawn now, copies with the same shape sharing one mesh asset; a clip that animates the
    /// SkinnedMeshRenderer itself is copied with its curves aimed at MeshRenderer, on a copy of its controller. Only real
    /// deformation and the still-manual cases (see SkinRigidByHand) keep a renderer skinned.
    /// </summary>
    /// <returns>How many renderers were converted (or would be, in a dry run).</returns>
    private static int UnskinRigid(Context context, TuneOptions options, List<Change> changes, List<Change> kept)
    {
        int converted = 0;
        var bakedMeshes = new Dictionary<string, Mesh>();
        string bakedFolder = UnskinnedMeshFolder(context.Scene);
        string clipFolder = RetargetedClipFolder(context.Scene);
        var curveAnimators = new List<Animator>();
        foreach (var renderer in context.Renderers.OfType<SkinnedMeshRenderer>().ToList())
        {
            string path = PathOf(renderer.transform);
            if (IsExcluded(renderer.transform, options.exclude)) { kept.Add(new Change { Kind = "skinned", Path = path, Why = "--exclude" }); continue; }
            var verdict = ClassifySkinning(renderer, context);
            int copies = context.RepeatCounts.TryGetValue(RepeatKey(renderer), out var count) ? count : 1;
            string copiesNote = copies > 1 ? " — " + copies + " copies" : "";
            if (!TuneConverts(verdict.Kind))
            {
                kept.Add(new Change { Kind = "skinned", Path = path, Why = verdict.Kind + ": " + verdict.Why + copiesNote + "; next: " + NextStepForSkinning(verdict.Kind, copies) });
                continue;
            }
            bool bakesPose = verdict.Kind == SkinRigidScriptHost || verdict.Kind == SkinFrozenPose;
            string howPlaced;
            var mesh = bakesPose
                ? BakedPoseMesh(renderer, bakedFolder, bakedMeshes, !options.dryRun, out howPlaced)
                : PlacedRigidMesh(renderer, verdict, context, options.dryRun, bakedFolder, bakedMeshes, out howPlaced);
            var animators = AnimatorsWithRendererCurves(renderer);
            curveAnimators.AddRange(animators);
            string retargetNote = animators.Count > 0 ? "; " + RetargetPlan(animators, renderer.transform, clipFolder) : "";
            bool clearsContributeGI = WithheldContributeGI(renderer.gameObject, path, context, options);
            changes.Add(new Change { Kind = UnskinnedChangeKind(verdict.Kind), Path = path, Before = "SkinnedMeshRenderer, " + verdict.Why,
                After = "MeshFilter + MeshRenderer, " + howPlaced + ", same materials",
                Why = UnskinnedReason(verdict.Kind) + copiesNote + retargetNote + (clearsContributeGI ? "; Contribute GI cleared — " + KeepGIReason : "") });
            converted++;
            if (options.dryRun)
            {
                context.PlannedUnskinned.Add(renderer);
                continue;
            }
            var gameObject = renderer.gameObject;
            ReplaceWithMeshRenderer(renderer, mesh);
            if (clearsContributeGI) GameObjectUtility.SetStaticEditorFlags(gameObject, GameObjectUtility.GetStaticEditorFlags(gameObject) & ~StaticEditorFlags.ContributeGI);
        }
        if (options.dryRun)
        {
            DiscardUnsavedMeshes(bakedMeshes.Values);
            return converted;
        }
        RetargetAnimators(curveAnimators.Distinct().ToList(), clipFolder);
        if (bakedMeshes.Count > 0 || curveAnimators.Count > 0) AssetDatabase.SaveAssets();
        return converted;
    }

    /// <summary>True for the skinning verdicts UnskinRigid converts to a plain mesh.</summary>
    private static bool TuneConverts(string verdictKind)
    {
        return verdictKind == SkinRigid || verdictKind == SkinRigidOffset || verdictKind == SkinRigidScriptHost
            || verdictKind == SkinRigidRendererCurves || verdictKind == SkinFrozenPose;
    }

    /// <summary>The tune.md change kind for a converted verdict.</summary>
    private static string UnskinnedChangeKind(string verdictKind)
    {
        if (verdictKind == SkinRigidScriptHost) return "Unskinned (script host)";
        if (verdictKind == SkinRigidRendererCurves) return "Unskinned (renderer curves)";
        if (verdictKind == SkinFrozenPose) return "Unskinned (frozen pose)";
        return "Unskinned (rigid)";
    }

    /// <summary>Why converting a renderer with this verdict is safe and what it buys.</summary>
    private static string UnskinnedReason(string verdictKind)
    {
        const string buys = "BabylonJS skins it every frame, and skinned copies can never share an instanced draw";
        if (verdictKind == SkinRigidScriptHost) return "the script on its own object stays and moves nothing apart from the mesh; baked as it is drawn now — " + buys;
        if (verdictKind == SkinFrozenPose) return "its pose never changes; baked once, and copies with the same pose share the mesh asset — " + buys;
        return "skinning bought nothing: " + buys;
    }

    /// <summary>
    /// The mesh a one-bone renderer draws once converted. Its own mesh when the bind pose matches; otherwise the leaf
    /// object is moved onto the bind pose (the mesh stays shared by every copy), and only when that is impossible is
    /// the offset baked into a mesh asset. A dry run changes nothing and returns the skinned mesh.
    /// </summary>
    private static Mesh PlacedRigidMesh(SkinnedMeshRenderer renderer, SkinningVerdict verdict, Context context, bool dryRun, string bakedFolder,
        Dictionary<string, Mesh> bakedMeshes, out string howPlaced)
    {
        var mesh = renderer.sharedMesh;
        howPlaced = "same mesh";
        if (!verdict.OffsetBaked) return mesh;
        bool reseat = CanReseatObject(renderer, context);
        if (!dryRun)
        {
            if (reseat) reseat = TryReseatObject(renderer.transform, mesh, verdict.MeshToWorld, RestPoseTolerance(renderer));
            if (!reseat) mesh = BakeOffsetMesh(mesh, verdict.MeshToObject, bakedFolder, bakedMeshes);
        }
        howPlaced = reseat ? "same mesh, object moved onto the bind pose" : "baked mesh in " + bakedFolder;
        return mesh;
    }

    /// <summary>
    /// True when --keep-gi must clear Contribute GI on a converted object: it carries the flag (a SkinnedMeshRenderer
    /// never takes part in the bake, the MeshRenderer that replaces it would) and did not contribute in the source.
    /// Keeps the context's planned contributor set in step.
    /// </summary>
    private static bool WithheldContributeGI(GameObject gameObject, string path, Context context, TuneOptions options)
    {
        if (!GameObjectUtility.GetStaticEditorFlags(gameObject).HasFlag(StaticEditorFlags.ContributeGI)) return false;
        if (WithheldFromBake(path, context, options)) return true;
        context.PlannedGIContributors.Add(path);
        return false;
    }

    /// <summary>Destroys the in-memory meshes a dry run baked to compare shapes (none of them was saved).</summary>
    private static void DiscardUnsavedMeshes(IEnumerable<Mesh> meshes)
    {
        foreach (var mesh in meshes.Where(mesh => !EditorUtility.IsPersistent(mesh)).ToList()) UnityEngine.Object.DestroyImmediate(mesh);
    }

    /// <summary>
    /// Swaps a SkinnedMeshRenderer for a MeshFilter + MeshRenderer on the same GameObject drawing `mesh` (the skinned
    /// mesh itself, its offset-baked copy or its baked pose), with the same materials and renderer settings: shadow
    /// casting and receiving, occlusion, both probe usages, the probe anchor, motion vectors, rendering layers and
    /// sorting. Bones, colliders, Animators and static flags stay as they are.
    /// </summary>
    private static void ReplaceWithMeshRenderer(SkinnedMeshRenderer skinned, Mesh mesh)
    {
        var gameObject = skinned.gameObject;
        var materials = skinned.sharedMaterials;
        var shadowCasting = skinned.shadowCastingMode;
        bool receiveShadows = skinned.receiveShadows, wasEnabled = skinned.enabled, allowOcclusion = skinned.allowOcclusionWhenDynamic;
        var probeUsage = skinned.lightProbeUsage;
        var reflectionUsage = skinned.reflectionProbeUsage;
        var probeAnchor = skinned.probeAnchor;
        var motionVectors = skinned.motionVectorGenerationMode;
        uint renderingLayers = skinned.renderingLayerMask;
        int sortingLayer = skinned.sortingLayerID, sortingOrder = skinned.sortingOrder;
        // Unity allows one Renderer per GameObject: the skinned one must go before the MeshRenderer can be added.
        UnityEngine.Object.DestroyImmediate(skinned);
        // Unity's missing-component result is a fake null that `??` does not see, so compare explicitly.
        var filter = gameObject.GetComponent<MeshFilter>();
        if (filter == null) filter = gameObject.AddComponent<MeshFilter>();
        filter.sharedMesh = mesh;
        var meshRenderer = gameObject.AddComponent<MeshRenderer>();
        meshRenderer.sharedMaterials = materials;
        meshRenderer.shadowCastingMode = shadowCasting;
        meshRenderer.receiveShadows = receiveShadows;
        meshRenderer.lightProbeUsage = probeUsage;
        meshRenderer.reflectionProbeUsage = reflectionUsage;
        meshRenderer.probeAnchor = probeAnchor;
        meshRenderer.motionVectorGenerationMode = motionVectors;
        meshRenderer.allowOcclusionWhenDynamic = allowOcclusion;
        meshRenderer.renderingLayerMask = renderingLayers;
        meshRenderer.sortingLayerID = sortingLayer;
        meshRenderer.sortingOrder = sortingOrder;
        meshRenderer.receiveGI = ReceiveGI.LightProbes;
        meshRenderer.enabled = wasEnabled;
        EditorUtility.SetDirty(gameObject);
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
            bool keptOutOfBake = lightmappable && WithheldFromBake(path, context, options);
            bool contributesGI = lightmappable && !keptOutOfBake;
            bool keepInstanceable = IsRepeatedForInstancing(renderer, context, options);
            var newFlags = StaticEditorFlags.BatchingStatic | StaticEditorFlags.OccludeeStatic | StaticEditorFlags.OccluderStatic | StaticEditorFlags.ReflectionProbeStatic;
            if (contributesGI)
            {
                newFlags |= StaticEditorFlags.ContributeGI;
                context.PlannedGIContributors.Add(path);
            }
            var receive = renderer.receiveGI;
            // A repeated prop still contributes bounce light, but stays probe-lit so its copies share one instanced draw.
            bool receivesLightmaps = !keepInstanceable && (contributesGI || (level > 0 && HasUV2(renderer) && LodZeroIsLightmapped(lod)));
            var newReceive = receivesLightmaps ? ReceiveGI.Lightmaps : ReceiveGI.LightProbes;
            if (!options.dryRun)
            {
                GameObjectUtility.SetStaticEditorFlags(gameObject, newFlags);
                renderer.receiveGI = newReceive;
                EditorUtility.SetDirty(renderer);
            }
            changes.Add(new Change { Kind = "Marked static", Path = path, Before = "not static, " + receive, After = (contributesGI ? "static + ContributeGI, " : "static, ") + newReceive,
                Why = "nothing in the browser moves it" + (DriverOf(gameObject, context) is string unityOnly ? " (Unity-only: " + unityOnly + ")" : "")
                    + (keepInstanceable ? "; stays probe-lit — " + context.RepeatCounts[RepeatKey(renderer)] + " copies share one instanced draw" : "")
                    + (keptOutOfBake ? "; " + KeepGIReason : "") });
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
            if (reason == null && IsRepeatedForInstancing(renderer, context, options))
                reason = context.RepeatCounts[RepeatKey(renderer)] + " copies: stays probe-lit so they share one instanced draw (lightmapped copies are exported as separate meshes)";
            bool addsContributeGI = !flags.HasFlag(StaticEditorFlags.ContributeGI);
            if (reason == null && addsContributeGI && WithheldFromBake(path, context, options)) reason = KeepGIReason;
            if (reason != null) { kept.Add(new Change { Kind = "probe-lit", Path = path, Why = reason }); continue; }
            string before = (addsContributeGI ? "no ContributeGI, " : "ContributeGI, ") + renderer.receiveGI;
            context.PlannedGIContributors.Add(path);
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
                        // --keep-gi keeps a lower level's own Contribute GI too: the copy's contributor set stays the source's.
                        var lowerFlags = GameObjectUtility.GetStaticEditorFlags(lower.gameObject) | StaticEditorFlags.BatchingStatic;
                        if (!options.keepSourceGI)
                        {
                            lowerFlags &= ~StaticEditorFlags.ContributeGI;
                            context.PlannedGIContributors.Remove(PathOf(lower.transform));
                        }
                        if (options.dryRun) continue;
                        GameObjectUtility.SetStaticEditorFlags(lower.gameObject, lowerFlags);
                        lower.receiveGI = ReceiveGI.Lightmaps;
                        EditorUtility.SetDirty(lower);
                    }
            }
            changes.Add(new Change { Kind = "Probe-lit → lightmapped", Path = path, Before = before, After = "ContributeGI, Lightmaps" + (lowerLevels > 0 ? " (+" + lowerLevels + " lower LOD renderers share LOD0's lightmap)" : ""),
                Why = "static with lightmap UVs; lightmapped meshes can merge" });
        }
    }

    /// <summary>
    /// Every unlightmapped copy in a repeat group (instanceRepeatsFrom copies or more of one mesh + materials) gets
    /// Light Probe Usage Off and Receive GI Light Probes, so its copies share one instanced draw: the toolkit loads every
    /// node that carries light probe data as its own mesh (SceneManager.DeinstanceProbeLitNodes). Reflection Probe Usage
    /// and Contribute GI stay as they are. Runs last of the renderer steps, so it sees what Lightmap probe-lit left
    /// unlightmapped; in a dry run it also covers the skinned copies UnskinRigid plans to convert.
    /// </summary>
    private static void InstanceRepeats(Context context, TuneOptions options, List<Change> changes, List<Change> kept)
    {
        var candidates = context.Renderers.OfType<MeshRenderer>().Cast<Renderer>().Concat(context.PlannedUnskinned);
        foreach (var renderer in candidates)
        {
            if (!IsRepeatedForInstancing(renderer, context, options)) continue;
            string path = PathOf(renderer.transform);
            if (IsExcluded(renderer.transform, options.exclude)) { kept.Add(new Change { Kind = "probe-lit repeat", Path = path, Why = "--exclude" }); continue; }
            var meshRenderer = renderer as MeshRenderer;
            // A converted skinned renderer comes out Receive GI Light Probes (see ReplaceWithMeshRenderer).
            var receive = meshRenderer != null ? meshRenderer.receiveGI : ReceiveGI.LightProbes;
            bool lightmapped = receive == ReceiveGI.Lightmaps && GameObjectUtility.GetStaticEditorFlags(renderer.gameObject).HasFlag(StaticEditorFlags.ContributeGI);
            if (lightmapped) continue;
            if (renderer.lightProbeUsage == LightProbeUsage.Off && receive == ReceiveGI.LightProbes) continue;
            changes.Add(new Change { Kind = "Light probes off (instancing)", Path = path,
                Before = "Light Probes " + renderer.lightProbeUsage + ", Receive GI " + receive + (meshRenderer == null ? " (once unskinned)" : ""),
                After = "Light Probes Off, Receive GI LightProbes, Reflection Probes " + renderer.reflectionProbeUsage,
                Why = context.RepeatCounts[RepeatKey(renderer)] + " copies share one instanced draw only with light probes off: the toolkit de-instances probe-lit nodes"
                    + " (SceneManager.DeinstanceProbeLitNodes); the copies light from the scene's ambient instead of the nearest probe" });
            if (options.dryRun || meshRenderer == null) continue;
            meshRenderer.lightProbeUsage = LightProbeUsage.Off;
            meshRenderer.receiveGI = ReceiveGI.LightProbes;
            EditorUtility.SetDirty(meshRenderer);
        }
    }

    /// <summary>
    /// True when --keep-gi forbids Contribute GI on the object at this hierarchy path: it did not contribute GI in the
    /// source scene, and adding it would pull the object into the re-bake (darkening the source's indirect light).
    /// </summary>
    private static bool WithheldFromBake(string path, Context context, TuneOptions options)
    {
        return options.keepSourceGI && !context.SourceGIContributors.Contains(path);
    }

    /// <summary>
    /// The hierarchy paths of the renderers that contribute GI in this scene's source: the scene named in the report
    /// folder's working-copy.txt, opened additively and closed again unsaved (an already open source is only read). A
    /// scene without that record (a dry run on the source itself) is its own source.
    /// </summary>
    private static HashSet<string> SourceGIContributorsOf(Scene scene, string reportFolder)
    {
        string recordPath = Path.Combine(reportFolder, "working-copy.txt");
        string sourcePath = File.Exists(recordPath) ? File.ReadAllText(recordPath).Trim() : scene.path;
        if (sourcePath == scene.path) return GIContributorPaths(scene.GetRootGameObjects());
        var openSource = SceneManager.GetSceneByPath(sourcePath);
        if (openSource.isLoaded) return GIContributorPaths(openSource.GetRootGameObjects());
        var source = EditorSceneManager.OpenScene(sourcePath, OpenSceneMode.Additive);
        try
        {
            return GIContributorPaths(source.GetRootGameObjects());
        }
        finally
        {
            EditorSceneManager.CloseScene(source, true);
        }
    }

    /// <summary>The hierarchy paths of the active, enabled MeshRenderers under the roots whose objects have Contribute GI.</summary>
    private static HashSet<string> GIContributorPaths(IEnumerable<GameObject> roots)
    {
        return new HashSet<string>(roots.SelectMany(root => root.GetComponentsInChildren<MeshRenderer>(true))
            .Where(renderer => renderer.enabled && renderer.gameObject.activeInHierarchy)
            .Where(renderer => GameObjectUtility.GetStaticEditorFlags(renderer.gameObject).HasFlag(StaticEditorFlags.ContributeGI))
            .Select(renderer => PathOf(renderer.transform)));
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
    // Skinning and repeats
    // ------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// What a skinned renderer really needs: one of the Skin* verdicts and the evidence. For a rigid mesh, also the
    /// fixed matrix that takes its mesh vertices to where the skinning draws them, in the object's local space.
    /// </summary>
    private sealed class SkinningVerdict
    {
        public string Kind, Why;
        /// <summary>True when the bind pose places the mesh farther from its object than the rest-pose tolerance; MeshToObject and MeshToWorld are then set.</summary>
        public bool OffsetBaked;
        public Matrix4x4 MeshToObject = Matrix4x4.identity;
        /// <summary>Where the skinning draws the mesh: bone × bind pose (mesh space to world space).</summary>
        public Matrix4x4 MeshToWorld = Matrix4x4.identity;
        public SkinningVerdict(string kind, string why) { Kind = kind; Why = why; }
    }

    /// <summary>
    /// Decides whether a SkinnedMeshRenderer needs skinning, from what actually deforms it: its weighted bones, blend
    /// shapes and cloth, and which transforms animation clips, Timeline or browser scripts move. An Animator alone
    /// decides nothing — most props' Animators only move, scale or toggle the object as a whole.
    /// </summary>
    private static SkinningVerdict ClassifySkinning(SkinnedMeshRenderer renderer, Context context)
    {
        var mesh = renderer.sharedMesh;
        if (mesh == null) return new SkinningVerdict(SkinDeforms, "no mesh");
        if (mesh.blendShapeCount > 0) return new SkinningVerdict(SkinDeforms, mesh.blendShapeCount + " blend shapes");
        if (renderer.GetComponent<Cloth>() != null) return new SkinningVerdict(SkinDeforms, "Cloth");
        var bones = renderer.bones;
        var weightedBoneIndices = WeightedBoneIndices(renderer);
        if (weightedBoneIndices.Count > 1)
        {
            string movedBone = weightedBoneIndices.Select(index => SeparateMotionBetween(bones[index], renderer.transform, context)).FirstOrDefault(motion => motion != null);
            if (movedBone != null) return new SkinningVerdict(SkinDeforms, weightedBoneIndices.Count + " weighted bones; " + movedBone);
            string poseBlocker = ConversionBlocker(renderer, context);
            return poseBlocker != null
                ? new SkinningVerdict(SkinRigidByHand, weightedBoneIndices.Count + " weighted bones that never move, but " + poseBlocker)
                : new SkinningVerdict(SkinFrozenPose, weightedBoneIndices.Count + " weighted bones, none moved by a clip, Timeline or script");
        }
        if (weightedBoneIndices.Count == 0 || mesh.bindposes.Length <= weightedBoneIndices[0]) return new SkinningVerdict(SkinRigidByHand, "no usable bone weights or bind poses");
        int boneIndex = weightedBoneIndices[0];
        var bone = bones[boneIndex];
        string separateMotion = SeparateMotionBetween(bone, renderer.transform, context);
        bool scriptHost = separateMotion != null && IsOnlyScriptOnRenderer(renderer, bone, context);
        if (separateMotion != null && !scriptHost) return new SkinningVerdict(SkinRigidByHand, "one bone, but it may move apart from the object (" + separateMotion + "): parent a plain mesh under '" + bone.name + "'");
        string blocker = ConversionBlocker(renderer, context);
        if (blocker != null) return new SkinningVerdict(SkinRigidByHand, "one bone ('" + bone.name + "'), but " + blocker);
        string curveNote = context.RendererCurveTargets.TryGetValue(renderer.transform, out var curve) ? "; a clip animates the SkinnedMeshRenderer itself (" + curve + ")" : "";
        if (scriptHost) return new SkinningVerdict(SkinRigidScriptHost, "one bone ('" + bone.name + "'); the only separate motion is " + separateMotion + ", on the renderer's own object" + curveNote);
        // A one-bone vertex is drawn at bone × bindpose × vertex; a MeshFilter draws it at object × vertex. The fixed
        // difference between the two, in the object's space, is all the skinning does.
        var meshToWorld = bone.localToWorldMatrix * mesh.bindposes[boneIndex];
        var meshToObject = renderer.transform.worldToLocalMatrix * meshToWorld;
        float offset = LargestVertexOffset(mesh, meshToObject, renderer.transform.lossyScale);
        bool offsetBaked = offset > RestPoseTolerance(renderer);
        string evidence = "one bone ('" + bone.name + "') moving with the object, no blend shapes or cloth"
            + (offsetBaked ? "; the bind pose offsets the mesh by up to " + offset.ToString("0.###") + " units" : ", bind pose within " + offset.ToString("0.####") + " units");
        string kind = offsetBaked ? SkinRigidOffset : SkinRigid;
        if (curveNote.Length > 0) kind = SkinRigidRendererCurves;
        var verdict = new SkinningVerdict(kind, evidence + curveNote) { OffsetBaked = offsetBaked };
        if (!offsetBaked) return verdict;
        verdict.MeshToObject = meshToObject;
        verdict.MeshToWorld = meshToWorld;
        return verdict;
    }

    /// <summary>
    /// Why a skinned renderer whose bones move with it still cannot be converted automatically, or null: a component
    /// references the SkinnedMeshRenderer itself, or a clip Tune cannot retarget animates it.
    /// </summary>
    private static string ConversionBlocker(SkinnedMeshRenderer renderer, Context context)
    {
        if (context.ReferencedComponents.Contains(renderer)) return "a component references the SkinnedMeshRenderer itself";
        return RendererCurveBlocker(renderer, context);
    }

    /// <summary>
    /// Why the clips that animate this SkinnedMeshRenderer cannot be retargeted to MeshRenderer, or null (also when no
    /// clip animates it). Only an Animator playing a plain AnimatorController can be given a retargeted copy.
    /// </summary>
    private static string RendererCurveBlocker(SkinnedMeshRenderer renderer, Context context)
    {
        if (!context.RendererCurveTargets.TryGetValue(renderer.transform, out var curve)) return null;
        foreach (var animation in renderer.GetComponentsInParent<Animation>(true))
            if (AnimationUtility.GetAnimationClips(animation.gameObject).Any(clip => AnimatesRenderer(clip, animation.transform, renderer.transform)))
                return "a legacy Animation on '" + animation.name + "' animates it (" + curve + "): retarget the curve to MeshRenderer by hand";
        foreach (var animator in renderer.GetComponentsInParent<Animator>(true))
        {
            var controller = animator.runtimeAnimatorController;
            if (controller == null || controller is UnityEditor.Animations.AnimatorController) continue;
            if (controller.animationClips.Any(clip => AnimatesRenderer(clip, animator.transform, renderer.transform)))
                return "the Animator on '" + animator.name + "' animates it through a " + controller.GetType().Name + " (" + curve + "): retarget the curve to MeshRenderer by hand";
        }
        return null;
    }

    /// <summary>
    /// True when the only separate motion between the bone and the renderer's object is a toolkit script on that object
    /// itself: no clip, Timeline, constraint, Rigidbody or script on either chain up to their common ancestor, and the
    /// renderer's own object has an EditorScriptComponent but is not animated and has no constraint or Rigidbody.
    /// </summary>
    private static bool IsOnlyScriptOnRenderer(SkinnedMeshRenderer renderer, Transform bone, Context context)
    {
        var rendererTransform = renderer.transform;
        var commonAncestor = CommonAncestor(bone, rendererTransform);
        if (rendererTransform == commonAncestor) return false;
        var otherLinks = ChainBelow(bone, commonAncestor).Concat(ChainBelow(rendererTransform.parent, commonAncestor));
        if (otherLinks.Any(node => MotionOn(node, context) != null)) return false;
        if (context.AnimatedTransforms.ContainsKey(rendererTransform)) return false;
        var components = rendererTransform.GetComponents<Component>();
        bool hasScript = components.Any(component => component is EditorScriptComponent);
        bool hasPhysicsOrConstraint = components.Any(component => component is Rigidbody || component is UnityEngine.Animations.IConstraint);
        return hasScript && !hasPhysicsOrConstraint;
    }

    /// <summary>How far, in world units, a converted vertex may land from where the skinning drew it.</summary>
    private static float RestPoseTolerance(Renderer renderer)
    {
        return Mathf.Max(RestPoseToleranceUnits, renderer.bounds.size.magnitude * RestPoseRelativeTolerance);
    }

    /// <summary>
    /// True when the renderer's object can simply be moved to where the skinning draws the mesh: a leaf with nothing on
    /// it but its Transform and renderer, that no clip animates and nothing references. Moving it keeps the original
    /// mesh, so every copy still shares one mesh (and one instanced draw).
    /// </summary>
    private static bool CanReseatObject(SkinnedMeshRenderer renderer, Context context)
    {
        var transform = renderer.transform;
        if (transform.childCount > 0 || context.AnimatedTransforms.ContainsKey(transform) || context.Referencers.ContainsKey(renderer.gameObject)) return false;
        return renderer.GetComponents<Component>().All(component => component is Transform || component is SkinnedMeshRenderer);
    }

    /// <summary>
    /// Moves the object so its transform equals `meshToWorld`, then checks every vertex lands where the skinning drew
    /// it. Restores the old pose and returns false when it cannot (shear, a parent's non-uniform scale under rotation).
    /// </summary>
    private static bool TryReseatObject(Transform transform, Mesh mesh, Matrix4x4 meshToWorld, float tolerance)
    {
        Vector3 oldPosition = transform.localPosition, oldScale = transform.localScale;
        Quaternion oldRotation = transform.localRotation;
        var parentScale = transform.parent != null ? transform.parent.lossyScale : Vector3.one;
        var targetScale = meshToWorld.lossyScale;
        transform.SetPositionAndRotation(meshToWorld.GetPosition(), meshToWorld.rotation);
        transform.localScale = new Vector3(targetScale.x / parentScale.x, targetScale.y / parentScale.y, targetScale.z / parentScale.z);
        var placed = transform.localToWorldMatrix;
        bool matches = mesh.vertices.All(vertex => Vector3.Distance(placed.MultiplyPoint3x4(vertex), meshToWorld.MultiplyPoint3x4(vertex)) <= tolerance);
        if (matches) return true;
        transform.localPosition = oldPosition;
        transform.localRotation = oldRotation;
        transform.localScale = oldScale;
        return false;
    }

    /// <summary>The indices of the bones that carry any vertex weight.</summary>
    private static List<int> WeightedBoneIndices(SkinnedMeshRenderer renderer)
    {
        var bones = renderer.bones;
        var weightedIndices = new HashSet<int>();
        foreach (var weight in renderer.sharedMesh.GetAllBoneWeights())
            if (weight.weight > 0f) weightedIndices.Add(weight.boneIndex);
        return weightedIndices.Where(index => index >= 0 && index < bones.Length && bones[index] != null).OrderBy(index => index).ToList();
    }

    /// <summary>The largest distance, in world units, that the matrix moves any vertex of the mesh.</summary>
    private static float LargestVertexOffset(Mesh mesh, Matrix4x4 meshToObject, Vector3 objectScale)
    {
        float largest = 0f;
        foreach (var vertex in mesh.vertices)
            largest = Mathf.Max(largest, Vector3.Scale(meshToObject.MultiplyPoint3x4(vertex) - vertex, objectScale).magnitude);
        return largest;
    }

    /// <summary>
    /// A plain copy of a rigid skinned mesh with its fixed bind-pose offset applied to positions, normals and
    /// tangents (winding flipped when the offset mirrors), saved once per mesh and offset so every copy shares it.
    /// </summary>
    private static Mesh BakeOffsetMesh(Mesh source, Matrix4x4 meshToObject, string folder, Dictionary<string, Mesh> bakedMeshes)
    {
        string offsetKey = string.Join(",", Enumerable.Range(0, 16).Select(index => Math.Round(meshToObject[index], SharedMeshKeyDecimals).ToString(System.Globalization.CultureInfo.InvariantCulture)));
        string cacheKey = source.GetHashCode() + "|" + offsetKey;
        if (bakedMeshes.TryGetValue(cacheKey, out var existing)) return existing;
        var baked = UnityEngine.Object.Instantiate(source);
        baked.name = source.name + "_Unskinned_" + bakedMeshes.Count;
        var normalMatrix = meshToObject.inverse.transpose;
        float handedness = meshToObject.determinant < 0f ? -1f : 1f;
        baked.vertices = source.vertices.Select(vertex => meshToObject.MultiplyPoint3x4(vertex)).ToArray();
        if (source.normals.Length > 0) baked.normals = source.normals.Select(normal => normalMatrix.MultiplyVector(normal).normalized).ToArray();
        if (source.tangents.Length > 0)
            baked.tangents = source.tangents.Select(tangent =>
            {
                var direction = meshToObject.MultiplyVector(new Vector3(tangent.x, tangent.y, tangent.z)).normalized;
                return new Vector4(direction.x, direction.y, direction.z, tangent.w * handedness);
            }).ToArray();
        if (handedness < 0f)
            for (int subMesh = 0; subMesh < baked.subMeshCount; subMesh++)
                baked.SetTriangles(baked.GetTriangles(subMesh).Reverse().ToArray(), subMesh);
        baked.boneWeights = new BoneWeight[0];
        baked.bindposes = new Matrix4x4[0];
        baked.RecalculateBounds();
        CreateMeshAsset(baked, folder);
        bakedMeshes[cacheKey] = baked;
        return baked;
    }

    /// <summary>
    /// Folder for meshes baked from skinned meshes (offset rigid meshes and baked poses): &lt;scene folder&gt;/&lt;scene&gt;_UnskinnedMeshes.
    /// BtCombine.PrepareCopy (reset) and RemoveCopy delete it with the working copy.
    /// </summary>
    private static string UnskinnedMeshFolder(Scene scene)
    {
        return Path.GetDirectoryName(scene.path).Replace('\\', '/') + "/" + scene.name + "_UnskinnedMeshes";
    }

    /// <summary>Folder for clips and controllers copied with their SkinnedMeshRenderer curves retargeted: &lt;scene folder&gt;/&lt;scene&gt;_RetargetedClips.</summary>
    private static string RetargetedClipFolder(Scene scene)
    {
        return Path.GetDirectoryName(scene.path).Replace('\\', '/') + "/" + scene.name + "_RetargetedClips";
    }

    /// <summary>Creates the project folder (one level below an existing folder) when it is missing.</summary>
    private static void EnsureFolder(string folder)
    {
        if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(Path.GetDirectoryName(folder).Replace('\\', '/'), Path.GetFileName(folder));
    }

    /// <summary>Saves the mesh as a new asset named after it in the folder (a unique path when the name is taken).</summary>
    private static void CreateMeshAsset(Mesh mesh, string folder)
    {
        EnsureFolder(folder);
        AssetDatabase.CreateAsset(mesh, AssetDatabase.GenerateUniqueAssetPath(folder + "/" + mesh.name + ".asset"));
    }

    /// <summary>
    /// The renderer's current skinned shape as a plain mesh in its object's space, shared by every renderer with the same
    /// source mesh and baked vertices (rounded to SharedMeshKeyDecimals) so the copies still instance. Saved in the
    /// folder unless `save` is false (a dry run, which only compares shapes; see DiscardUnsavedMeshes).
    /// </summary>
    private static Mesh BakedPoseMesh(SkinnedMeshRenderer skinned, string folder, Dictionary<string, Mesh> bakedMeshes, bool save, out string howPlaced)
    {
        var source = skinned.sharedMesh;
        var baked = BakePoseToObjectSpace(skinned);
        string shapeKey = PoseShapeKey(source, baked);
        if (bakedMeshes.TryGetValue(shapeKey, out var existing))
        {
            UnityEngine.Object.DestroyImmediate(baked);
            baked = existing;
        }
        else
        {
            string namePrefix = source.name + "_Pose_";
            baked.name = namePrefix + bakedMeshes.Values.Count(mesh => mesh.name.StartsWith(namePrefix, StringComparison.Ordinal));
            if (save) CreateMeshAsset(baked, folder);
            bakedMeshes[shapeKey] = baked;
        }
        string assetPath = EditorUtility.IsPersistent(baked) ? AssetDatabase.GetAssetPath(baked) : folder + "/" + baked.name + ".asset";
        howPlaced = "baked pose, shared mesh asset " + assetPath;
        return baked;
    }

    /// <summary>
    /// A copy of the renderer's mesh with linear-blend skinning applied at the current bone pose, expressed in the
    /// renderer object's local space (what a MeshFilter on that object must draw), with the skin data removed. A vertex
    /// with no weights keeps its position.
    /// </summary>
    private static Mesh BakePoseToObjectSpace(SkinnedMeshRenderer skinned)
    {
        var source = skinned.sharedMesh;
        var boneToObject = BoneToObjectMatrices(skinned);
        var normalMatrices = boneToObject.Select(matrix => matrix.inverse.transpose).ToArray();
        var bonesPerVertex = source.GetBonesPerVertex();
        var weights = source.GetAllBoneWeights();
        var vertices = source.vertices;
        var normals = source.normals;
        var tangents = source.tangents;
        int weightIndex = 0;
        for (int i = 0; i < vertices.Length; i++)
        {
            Vector3 position = Vector3.zero, normal = Vector3.zero, tangent = Vector3.zero;
            int influenceCount = bonesPerVertex[i];
            for (int j = 0; j < influenceCount; j++, weightIndex++)
            {
                var influence = weights[weightIndex];
                position += influence.weight * boneToObject[influence.boneIndex].MultiplyPoint3x4(vertices[i]);
                if (normals.Length > 0) normal += influence.weight * normalMatrices[influence.boneIndex].MultiplyVector(normals[i]);
                if (tangents.Length > 0) tangent += influence.weight * boneToObject[influence.boneIndex].MultiplyVector(tangents[i]);
            }
            if (influenceCount == 0) continue;
            vertices[i] = position;
            if (normals.Length > 0) normals[i] = normal.normalized;
            if (tangents.Length > 0)
            {
                var direction = tangent.normalized;
                tangents[i] = new Vector4(direction.x, direction.y, direction.z, tangents[i].w);
            }
        }
        var baked = UnityEngine.Object.Instantiate(source);
        baked.boneWeights = new BoneWeight[0];
        baked.bindposes = new Matrix4x4[0];
        baked.vertices = vertices;
        if (normals.Length > 0) baked.normals = normals;
        if (tangents.Length > 0) baked.tangents = tangents;
        baked.RecalculateBounds();
        return baked;
    }

    /// <summary>For each bone: object-from-world × bone-to-world × bind pose (identity for a missing bone or bind pose).</summary>
    private static Matrix4x4[] BoneToObjectMatrices(SkinnedMeshRenderer skinned)
    {
        var bones = skinned.bones;
        var bindposes = skinned.sharedMesh.bindposes;
        var worldToObject = skinned.transform.worldToLocalMatrix;
        var matrices = new Matrix4x4[bones.Length];
        for (int i = 0; i < bones.Length; i++)
            matrices[i] = bones[i] != null && i < bindposes.Length ? worldToObject * bones[i].localToWorldMatrix * bindposes[i] : Matrix4x4.identity;
        return matrices;
    }

    /// <summary>Identifies a baked shape: the source mesh plus its vertex positions rounded to SharedMeshKeyDecimals.</summary>
    private static string PoseShapeKey(Mesh source, Mesh baked)
    {
        string format = "F" + SharedMeshKeyDecimals;
        var culture = System.Globalization.CultureInfo.InvariantCulture;
        var rounded = baked.vertices.Select(vertex => vertex.x.ToString(format, culture) + "," + vertex.y.ToString(format, culture) + "," + vertex.z.ToString(format, culture));
        return "pose|" + source.GetHashCode() + "|" + string.Join(";", rounded).GetHashCode();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Renderer curves — clips that animate a SkinnedMeshRenderer, retargeted to the MeshRenderer that replaces it
    // ------------------------------------------------------------------------------------------------------------

    /// <summary>The clip's float and object-reference curve bindings that target a SkinnedMeshRenderer.</summary>
    private static List<EditorCurveBinding> RendererBindings(AnimationClip clip)
    {
        return AnimationUtility.GetCurveBindings(clip).Concat(AnimationUtility.GetObjectReferenceCurveBindings(clip))
            .Where(binding => binding.type == typeof(SkinnedMeshRenderer)).ToList();
    }

    /// <summary>The transform a curve binding targets, resolved from the animated root, or null.</summary>
    private static Transform ResolveBinding(Transform animatedRoot, EditorCurveBinding binding)
    {
        return binding.path == "" ? animatedRoot : animatedRoot.Find(binding.path);
    }

    /// <summary>True when the clip, played from the animated root, animates the SkinnedMeshRenderer on the target.</summary>
    private static bool AnimatesRenderer(AnimationClip clip, Transform animatedRoot, Transform target)
    {
        return clip != null && RendererBindings(clip).Any(binding => ResolveBinding(animatedRoot, binding) == target);
    }

    /// <summary>The Animators on or above the renderer whose controller's clips animate that SkinnedMeshRenderer.</summary>
    private static List<Animator> AnimatorsWithRendererCurves(SkinnedMeshRenderer skinned)
    {
        return skinned.GetComponentsInParent<Animator>(true)
            .Where(animator => animator.runtimeAnimatorController is UnityEditor.Animations.AnimatorController)
            .Where(animator => animator.runtimeAnimatorController.animationClips.Any(clip => AnimatesRenderer(clip, animator.transform, skinned.transform)))
            .ToList();
    }

    /// <summary>Names, for the report, each clip that will be copied with its curves retargeted and the controller copy that plays it.</summary>
    private static string RetargetPlan(List<Animator> animators, Transform target, string folder)
    {
        var plans = animators.Select(animator =>
        {
            var controller = (UnityEditor.Animations.AnimatorController)animator.runtimeAnimatorController;
            var clipNames = controller.animationClips.Where(clip => AnimatesRenderer(clip, animator.transform, target)).Select(clip => "'" + clip.name + "'").Distinct();
            return "clip " + string.Join(", ", clipNames) + " copied with its SkinnedMeshRenderer curves aimed at MeshRenderer, played by controller copy "
                + RetargetedControllerPath(controller, folder) + " (Animator on " + animator.name + ")";
        });
        return string.Join("; ", plans);
    }

    /// <summary>Where the retargeted copy of a controller is saved.</summary>
    private static string RetargetedControllerPath(UnityEditor.Animations.AnimatorController controller, string folder)
    {
        return folder + "/" + controller.name + "_MeshRenderer.controller";
    }

    /// <summary>
    /// Gives each Animator a copy of its controller whose clips aim every SkinnedMeshRenderer curve at a converted object
    /// (one that now has a MeshRenderer) at MeshRenderer instead, same path and property. Animators sharing a controller
    /// share its copy. The original clips and controllers are never edited; only the Animators in this scene change.
    /// </summary>
    private static void RetargetAnimators(List<Animator> animators, string folder)
    {
        var controllerCopies = new Dictionary<UnityEditor.Animations.AnimatorController, UnityEditor.Animations.AnimatorController>();
        var clipCopies = new Dictionary<AnimationClip, AnimationClip>();
        foreach (var animator in animators)
        {
            var controller = (UnityEditor.Animations.AnimatorController)animator.runtimeAnimatorController;
            if (!controllerCopies.TryGetValue(controller, out var copy))
            {
                copy = RetargetedController(controller, animator.transform, folder, clipCopies);
                controllerCopies[controller] = copy;
            }
            animator.runtimeAnimatorController = copy;
            EditorUtility.SetDirty(animator);
        }
    }

    /// <summary>
    /// A fresh copy of the controller (replacing a copy an earlier run left) with every clip that has retargeted curves
    /// swapped for its copy, in every state and blend tree of every layer.
    /// </summary>
    private static UnityEditor.Animations.AnimatorController RetargetedController(UnityEditor.Animations.AnimatorController controller, Transform animatedRoot,
        string folder, Dictionary<AnimationClip, AnimationClip> clipCopies)
    {
        EnsureFolder(folder);
        string copyPath = RetargetedControllerPath(controller, folder);
        AssetDatabase.DeleteAsset(copyPath);
        if (!AssetDatabase.CopyAsset(AssetDatabase.GetAssetPath(controller), copyPath)) throw new InvalidOperationException("Could not copy " + controller.name + " to " + copyPath);
        var copy = AssetDatabase.LoadAssetAtPath<UnityEditor.Animations.AnimatorController>(copyPath);
        var replacements = new Dictionary<AnimationClip, AnimationClip>();
        foreach (var clip in controller.animationClips.Where(clip => clip != null).Distinct())
        {
            var retargeted = RetargetedClip(clip, animatedRoot, folder, clipCopies);
            if (retargeted != null) replacements[clip] = retargeted;
        }
        foreach (var layer in copy.layers) ReplaceMotions(layer.stateMachine, replacements);
        EditorUtility.SetDirty(copy);
        return copy;
    }

    /// <summary>
    /// A copy of the clip with every SkinnedMeshRenderer curve whose target now has a MeshRenderer retargeted to
    /// MeshRenderer (same path and property), saved in the folder as &lt;clip&gt;_MeshRenderer.anim (an earlier run's copy
    /// is updated in place). Null when the clip has no such curve. Each clip is copied once per run.
    /// </summary>
    private static AnimationClip RetargetedClip(AnimationClip clip, Transform animatedRoot, string folder, Dictionary<AnimationClip, AnimationClip> clipCopies)
    {
        if (clipCopies.TryGetValue(clip, out var done)) return done;
        var bindings = RendererBindings(clip).Where(binding => ResolveBinding(animatedRoot, binding) is Transform target && target.GetComponent<MeshRenderer>() != null).ToList();
        if (bindings.Count == 0) return null;
        var retargeted = UnityEngine.Object.Instantiate(clip);
        retargeted.name = clip.name + "_MeshRenderer";
        foreach (var binding in bindings) RetargetBinding(clip, retargeted, binding);
        string clipPath = folder + "/" + retargeted.name + ".anim";
        var previous = AssetDatabase.LoadAssetAtPath<AnimationClip>(clipPath);
        if (previous == null)
        {
            AssetDatabase.CreateAsset(retargeted, clipPath);
        }
        else
        {
            EditorUtility.CopySerialized(retargeted, previous);
            UnityEngine.Object.DestroyImmediate(retargeted);
            retargeted = previous;
        }
        clipCopies[clip] = retargeted;
        return retargeted;
    }

    /// <summary>Moves one curve of the copied clip from the SkinnedMeshRenderer binding to the same MeshRenderer binding.</summary>
    private static void RetargetBinding(AnimationClip source, AnimationClip retargeted, EditorCurveBinding binding)
    {
        var meshBinding = binding;
        meshBinding.type = typeof(MeshRenderer);
        if (binding.isPPtrCurve)
        {
            var keyframes = AnimationUtility.GetObjectReferenceCurve(source, binding);
            AnimationUtility.SetObjectReferenceCurve(retargeted, binding, null);
            AnimationUtility.SetObjectReferenceCurve(retargeted, meshBinding, keyframes);
            return;
        }
        var curve = AnimationUtility.GetEditorCurve(source, binding);
        AnimationUtility.SetEditorCurve(retargeted, binding, null);
        AnimationUtility.SetEditorCurve(retargeted, meshBinding, curve);
    }

    /// <summary>Swaps state motions in the state machine (and its sub-state machines) for their replacements.</summary>
    private static void ReplaceMotions(UnityEditor.Animations.AnimatorStateMachine stateMachine, Dictionary<AnimationClip, AnimationClip> replacements)
    {
        foreach (var child in stateMachine.states) child.state.motion = ReplacedMotion(child.state.motion, replacements);
        foreach (var child in stateMachine.stateMachines) ReplaceMotions(child.stateMachine, replacements);
    }

    /// <summary>The motion with every replaced clip swapped in: the clip's replacement, or a blend tree with its children swapped.</summary>
    private static Motion ReplacedMotion(Motion motion, Dictionary<AnimationClip, AnimationClip> replacements)
    {
        if (motion is AnimationClip clip) return replacements.TryGetValue(clip, out var replacement) ? replacement : clip;
        if (!(motion is UnityEditor.Animations.BlendTree blendTree)) return motion;
        var children = blendTree.children;
        for (int i = 0; i < children.Length; i++) children[i].motion = ReplacedMotion(children[i].motion, replacements);
        blendTree.children = children;
        return blendTree;
    }

    /// <summary>
    /// What moves the bone relative to the renderer's object, or null when the two always move together. Only the
    /// transforms between each of them and their nearest common ancestor count: whatever moves that ancestor (an
    /// Animator popping the whole prop in, a script spinning it) moves bone and mesh alike.
    /// </summary>
    private static string SeparateMotionBetween(Transform bone, Transform rendererTransform, Context context)
    {
        var commonAncestor = CommonAncestor(bone, rendererTransform);
        return ChainBelow(bone, commonAncestor).Concat(ChainBelow(rendererTransform, commonAncestor))
            .Select(node => MotionOn(node, context)).FirstOrDefault(motion => motion != null);
    }

    /// <summary>The nearest transform that is the bone or one of its ancestors and also the renderer's object or one of its ancestors (null when none is).</summary>
    private static Transform CommonAncestor(Transform bone, Transform rendererTransform)
    {
        var rendererAncestors = new HashSet<Transform>();
        for (var node = rendererTransform; node != null; node = node.parent) rendererAncestors.Add(node);
        var commonAncestor = bone;
        while (commonAncestor != null && !rendererAncestors.Contains(commonAncestor)) commonAncestor = commonAncestor.parent;
        return commonAncestor;
    }

    /// <summary>The transform and its ancestors up to, but not including, the ancestor (empty when start is null or the ancestor).</summary>
    private static IEnumerable<Transform> ChainBelow(Transform start, Transform ancestor)
    {
        for (var node = start; node != null && node != ancestor; node = node.parent) yield return node;
    }

    /// <summary>What can move this one transform on its own — a clip or Timeline, a toolkit script, a Rigidbody or a constraint — or null.</summary>
    private static string MotionOn(Transform node, Context context)
    {
        if (context.AnimatedTransforms.TryGetValue(node, out var animator)) return "'" + node.name + "' is animated by " + animator;
        foreach (var component in node.GetComponents<Component>())
            if (component is EditorScriptComponent || component is Rigidbody || component is UnityEngine.Animations.IConstraint)
                return "'" + node.name + "' has " + component.GetType().Name;
        return null;
    }

    /// <summary>True when the renderer's mesh and materials repeat often enough that its copies should share an instanced draw.</summary>
    private static bool IsRepeatedForInstancing(Renderer renderer, Context context, TuneOptions options)
    {
        return options.instanceRepeatsFrom > 0 && context.RepeatCounts.TryGetValue(RepeatKey(renderer), out var copies) && copies >= options.instanceRepeatsFrom;
    }

    /// <summary>
    /// Identifies renderers that draw the same mesh with the same materials (the copies an instanced draw can share).
    /// Unity objects hash by identity, which works on every Editor version (GetInstanceID is obsolete in Unity 6.5).
    /// </summary>
    private static string RepeatKey(Renderer renderer)
    {
        var mesh = MeshOf(renderer);
        string meshKey = mesh != null ? mesh.GetHashCode().ToString() : "none";
        return meshKey + "|" + string.Join(",", renderer.sharedMaterials.Select(material => material != null ? material.GetHashCode() : 0));
    }

    /// <summary>The mesh a Mesh or SkinnedMeshRenderer draws.</summary>
    private static Mesh MeshOf(Renderer renderer)
    {
        if (renderer is SkinnedMeshRenderer skinned) return skinned.sharedMesh;
        var filter = renderer.GetComponent<MeshFilter>();
        return filter != null ? filter.sharedMesh : null;
    }

    /// <summary>Draw calls one copy costs per pass: one per submesh.</summary>
    private static int SubMeshCount(Renderer renderer)
    {
        var mesh = MeshOf(renderer);
        return mesh != null ? Mathf.Max(1, mesh.subMeshCount) : 1;
    }

    /// <summary>The reflection probe that lights the renderer most (the exporter splits a material per probe), or "".</summary>
    private static string DominantReflectionProbe(Renderer renderer)
    {
        var probes = new List<ReflectionProbeBlendInfo>();
        renderer.GetClosestReflectionProbes(probes);
        var dominant = probes.OrderByDescending(probe => probe.weight).FirstOrDefault();
        return dominant.probe != null ? dominant.probe.name : "";
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
        /// <summary>Transforms an animation clip (Animator / Animation) or a Timeline moves, with what moves them.</summary>
        public readonly Dictionary<Transform, string> AnimatedTransforms;
        /// <summary>Objects whose Renderer / SkinnedMeshRenderer a clip animates directly, with the curve.</summary>
        public readonly Dictionary<Transform, string> RendererCurveTargets;
        /// <summary>Components (not just GameObjects) a serialized field points at.</summary>
        public readonly HashSet<Component> ReferencedComponents;
        /// <summary>How many active renderers draw each mesh + materials combination (see RepeatKey).</summary>
        public readonly Dictionary<string, int> RepeatCounts;
        /// <summary>Hierarchy paths of the renderers that contribute GI in the source scene (Tune only; empty for a survey).</summary>
        public readonly HashSet<string> SourceGIContributors;
        /// <summary>
        /// Hierarchy paths of the renderers that contribute GI once Tune's changes land. Starts as the scene's own set;
        /// the steps keep it in step with the Contribute GI flags they add or clear, so a dry run can count it too.
        /// </summary>
        public readonly HashSet<string> PlannedGIContributors;
        /// <summary>Skinned renderers a dry run plans to convert: later steps treat them as the MeshRenderers they become.</summary>
        public readonly List<SkinnedMeshRenderer> PlannedUnskinned = new List<SkinnedMeshRenderer>();
        public readonly StringBuilder Summary = new StringBuilder();

        /// <param name="scene">The scene to gather.</param>
        /// <param name="sourceGIContributors">Tune's source contributor set (see SourceGIContributorsOf); null for a survey.</param>
        public Context(Scene scene, HashSet<string> sourceGIContributors = null)
        {
            Scene = scene;
            Roots = scene.GetRootGameObjects().ToList();
            Lights = All<Light>().Where(light => light.isActiveAndEnabled).ToList();
            Renderers = All<Renderer>().Where(renderer => renderer.enabled && renderer.gameObject.activeInHierarchy && (renderer is MeshRenderer || renderer is SkinnedMeshRenderer)).ToList();
            Referencers = CollectReferencers(Roots, false);
            WebReferencers = CollectReferencers(Roots, true);
            TimelineBound = CollectTimelineBindings(Roots);
            AnimatedTransforms = new Dictionary<Transform, string>();
            RendererCurveTargets = new Dictionary<Transform, string>();
            CollectAnimationTargets(this);
            ReferencedComponents = CollectReferencedComponents(Roots);
            RepeatCounts = Renderers.GroupBy(RepeatKey).ToDictionary(group => group.Key, group => group.Count());
            SourceGIContributors = sourceGIContributors ?? new HashSet<string>();
            PlannedGIContributors = GIContributorPaths(Roots);
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

    /// <summary>
    /// Fills the context's AnimatedTransforms (every transform a clip of an Animator or legacy Animation moves, plus
    /// every Timeline-bound object and its children) and RendererCurveTargets (objects whose renderer component a clip
    /// animates — converting that renderer would break the curve).
    /// </summary>
    private static void CollectAnimationTargets(Context context)
    {
        foreach (var root in context.Roots)
        {
            foreach (var animator in root.GetComponentsInChildren<Animator>(true))
            {
                var clips = animator.runtimeAnimatorController != null ? animator.runtimeAnimatorController.animationClips : new AnimationClip[0];
                AddClipTargets(context, animator.transform, clips, "Animator on " + animator.name);
            }
            foreach (var animation in root.GetComponentsInChildren<Animation>(true))
                AddClipTargets(context, animation.transform, AnimationUtility.GetAnimationClips(animation.gameObject), "Animation on " + animation.name);
        }
        foreach (var bound in context.TimelineBound)
            foreach (var node in bound.GetComponentsInChildren<Transform>(true))
                context.AnimatedTransforms[node] = "a Timeline track";
    }

    /// <summary>Records what each clip's curves move, resolving curve paths from the animating object.</summary>
    private static void AddClipTargets(Context context, Transform animatedRoot, IEnumerable<AnimationClip> clips, string source)
    {
        foreach (var clip in clips.Where(clip => clip != null).Distinct())
            foreach (var binding in AnimationUtility.GetCurveBindings(clip).Concat(AnimationUtility.GetObjectReferenceCurveBindings(clip)))
            {
                var target = binding.path == "" ? animatedRoot : animatedRoot.Find(binding.path);
                if (target == null) continue;
                if (binding.type == typeof(Transform)) context.AnimatedTransforms[target] = source + " (clip '" + clip.name + "')";
                else if (typeof(Renderer).IsAssignableFrom(binding.type)) context.RendererCurveTargets[target] = binding.type.Name + "." + binding.propertyName + " in '" + clip.name + "'";
            }
    }

    /// <summary>Every component a serialized field in the scene points at directly (a GameObject reference does not count).</summary>
    private static HashSet<Component> CollectReferencedComponents(List<GameObject> roots)
    {
        var referenced = new HashSet<Component>();
        foreach (var root in roots)
            foreach (var component in root.GetComponentsInChildren<Component>(true))
            {
                if (component == null || component is Transform || component is MeshFilter || component is Renderer || component is LODGroup) continue;
                var property = new SerializedObject(component).GetIterator();
                while (property.Next(true))
                    if (property.propertyType == SerializedPropertyType.ObjectReference && property.objectReferenceValue is Component target && target != component)
                        referenced.Add(target);
            }
        return referenced;
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
