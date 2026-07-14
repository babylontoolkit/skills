# bt-create — Public Asset Library (hosted interactive glTF)

Base URL: `https://repo.babylontoolkit.com/playground/`

These are **interactive glTF** files exported from Unity via the Babylon Toolkit Exporter. Their `extras.metadata.components` are re-hydrated LIVE at load by `TOOLKIT.SceneManager` — scenes arrive as playable levels, prefabs arrive as finished objects. **Configure them; never re-implement them** (see `capability-inventory.md`).

## Scenes (levels — environment, lighting, colliders included)

| File | What it is | Good for |
|---|---|---|
| `samplescene.gz.gltf` | Sample playground level with props and colliders | Adventure / player demos, quick playable spaces |
| `openterrain.gz.gltf` | Open drivable terrain | Racing / driving, open-world experiments |

## Prefabs (finished interactive objects — components attached & tuned)

| File | Root node | Ships with (LIVE at load) | You write |
|---|---|---|---|
| `riggedmustang.gltf` | `RiggedMustang` | `PROJECT.StandardCarController` (engine, gearbox, suspension, tire friction, skid/drift/burnout), `PROJECT.VehicleInputController`, `PROJECT.VehicleCameraManager` | `input.enableInput = true` + property tweaks |
| `playerarmature.gltf` | `PlayerArmature` | `TOOLKIT.CharacterController` (capsule physics, grounding, slopes, steps), `PROJECT.ThirdPersonPlayerController` (movement, jump, camera, animation params, climb/vault) | `attachCamera = true`, `enableInput = true` |

## The canonical loading pattern

```ts
const assetsManager = new BABYLON.AssetsManager(scene);
assetsManager.addMeshTask("openterrain.gz.gltf", null, repo, "openterrain.gz.gltf");
assetsManager.addMeshTask("riggedmustang.gltf", null, repo, "riggedmustang.gltf");
await TOOLKIT.SceneManager.LoadRuntimeAssets(assetsManager, ["openterrain.gz.gltf", "riggedmustang.gltf"], () => {
  const mustang = scene.getNodeByName("RiggedMustang") as BABYLON.TransformNode;
  const input = TOOLKIT.SceneManager.FindScriptComponent(mustang, "PROJECT.VehicleInputController");
  input.enableInput = true; // complete driving game — zero physics written
});
```

## Serving requirements (when self-hosting assets)

`.gz.*` files require `Content-Encoding: gzip` and correct glTF MIME types (`model/gltf+json` / `model/gltf-binary`); Havok needs COOP/COEP headers on the serving origin. The StarterAssets `vite.config` handles all of this in dev — mirror it in production hosting.

## User-supplied assets

Users may reference their own exported interactive glTF (from the Toolkit's Unity Exporter) by URL or local file. Treat identically: load through `LoadRuntimeAssets`, scan `extras.metadata.components` to learn what's attached (per `scene-components.md`), then configure the live components.

---

*Grow this table as new public scenes and prefabs ship. The starter repo and the playground repo are the source of truth for what exists.*
