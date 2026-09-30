// SOURCE: AgentReference references/scripts/bt-bootstrap.cs (the babylontoolkit/agent repo) - keep in sync.
// Everything below the marker line is a VERBATIM copy of that file. tests/bridge-unity-scaffold.test.js pins its
// sha256 (7970a089b7600e344e8c2ac482d1480bcd8d9567853fc8248f0e792d8b66f824), recorded from the source at copy time: re-copy the file and update the hash together.
// ---- verbatim from here ----
// Headless replication of CVPanel.OnEnable() - the Scene Exporter bootstrap.
// Safe to run in a GUI Editor too (it is idempotent).
var sb = new System.Text.StringBuilder();
CanvasTools.CanvasToolsExporter.Initialize();
CanvasToolsInfo.DefaultProjectFolder = UnityTools.GetDefaultExportFolder();
UnityTools.ValidateRequirements();
UnityTools.ValidateImageLibrary();
UnityTools.ValidateProjectScript();
UnityTools.ValidateProjectLayers();
UnityTools.ValidateColorSpaceSettings();
UnityTools.ValidateGraphicsLibSettings();
UnityTools.ValidateProjectRootNamespace();
UnityTools.ValidateProjectShaderSettings();
UnityTools.ValidateReflectionProbeSettings();
// The GPU Resident Drawer is Unity-only batching the export never uses; left on, a failed registration makes
// camera captures render only the sky. Toolkit 9.25+, dialog-free.
sb.Append("residentDrawerOff=" + RenderPathTools.DisableResidentDrawer(false) + " ");
if (System.String.IsNullOrWhiteSpace(CanvasToolsInfo.Instance.ProductShortName)
    && !System.String.IsNullOrWhiteSpace(UnityEngine.Application.productName))
    CanvasToolsInfo.Instance.ProductShortName = UnityEngine.Application.productName;
if (CanvasToolsInfo.Instance.InlineNonceHash == null) CanvasToolsInfo.Instance.InlineNonceHash = "";
string root = UnityTools.GetRootPath();
string pj = System.IO.Path.Combine(root, "package.json");
if (!System.IO.File.Exists(pj)) {
    string j = "{\r\n\t\"name\": \"" + BabylonCore.Info.NAME + "\",\r\n\t\"version\": \"" + BabylonCore.Info.VERSION
      + "\",\r\n\t\"description\": \"Babylon Toolkit Project\",\r\n\t\"license\": \"MIT\",\r\n\t\"devDependencies\": {\r\n\t\t\"typescript\": \"^"
      + BabylonCore.Info.TYPESCRIPT + "\"\r\n\t}\r\n}\r\n";
    System.IO.File.WriteAllText(pj, j);
    sb.Append("packageJson=written ");
} else sb.Append("packageJson=present ");
CanvasToolsInfo.SaveSettings();
UnityEditor.AssetDatabase.Refresh();
sb.Append("exportRoot=" + CanvasToolsInfo.DefaultProjectFolder);
sb.Append(" pro=" + ToolkitManager.IsPro());
return sb.ToString();
