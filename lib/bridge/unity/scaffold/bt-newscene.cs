// SOURCE: AgentReference references/scripts/bt-newscene.cs (the babylontoolkit/agent repo) - keep in sync.
// Everything below the marker line is a VERBATIM copy of that file. tests/bridge-unity-scaffold.test.js pins its
// sha256 (00829f0a2eb162dcf63d56f54a69e16dd1d5decd3c7addcfef41e34af3d2ff97), recorded from the source at copy time: re-copy the file and update the hash together.
// ---- verbatim from here ----
// Create a starter scene WITH LightingSettings (order: NewScene -> build -> save -> lighting).
string sceneName = "Level01";
var scene = UnityEditor.SceneManagement.EditorSceneManager.NewScene(
    UnityEditor.SceneManagement.NewSceneSetup.DefaultGameObjects,
    UnityEditor.SceneManagement.NewSceneMode.Single);
var ground = UnityEngine.GameObject.CreatePrimitive(UnityEngine.PrimitiveType.Plane);
ground.name = "Ground"; ground.transform.localScale = new UnityEngine.Vector3(5f,1f,5f);
UnityEngine.RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Skybox;
System.IO.Directory.CreateDirectory(UnityEngine.Application.dataPath + "/Scenes");
UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene, "Assets/Scenes/" + sceneName + ".unity");
UnityEngine.LightingSettings ls = null;
if (!UnityEditor.Lightmapping.TryGetLightingSettings(out ls) || ls == null) {
    var nls = new UnityEngine.LightingSettings(); nls.name = "BtLightingSettings";
    System.IO.Directory.CreateDirectory(UnityEngine.Application.dataPath + "/Settings");
    UnityEditor.AssetDatabase.CreateAsset(nls, "Assets/Settings/BtLightingSettings.lighting");
    UnityEditor.Lightmapping.lightingSettings = nls;
}
// Assigning lightingSettings does NOT mark the scene dirty, so SaveOpenScenes() skips it
// and the reference is lost the next time the scene is loaded (sec 8.1).
UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(scene);
UnityEditor.SceneManagement.EditorSceneManager.SaveOpenScenes();
UnityEditor.AssetDatabase.SaveAssets();
return "scene=Assets/Scenes/" + sceneName + ".unity lighting=ok";
