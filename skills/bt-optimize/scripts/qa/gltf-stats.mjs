/**
 * bt-combine export stats: compares exported .gltf scenes — drawn mesh nodes, meshes, primitives (draw calls before
 * LOD selection), materials, textures, drawn vertices and the size on disk of the .gltf plus its buffers.
 *
 * Usage:
 *   node gltf-stats.mjs export/scenes/original.gltf export/scenes/combined.gltf
 */
import fs from "node:fs";
import path from "node:path";

/** Bytes per megabyte, for readable sizes. */
const BYTES_PER_MEGABYTE = 1024 * 1024;

/**
 * Reads one exported scene and measures it.
 * @param {string} gltfPath - path of the .gltf file
 * @returns {{file: string, nodes: number, drawnMeshNodes: number, meshes: number, primitives: number, materials: number,
 *   textures: number, drawnVertices: number, sizeMegabytes: number}} the measurements
 */
function measure(gltfPath) {
    const gltf = JSON.parse(fs.readFileSync(gltfPath, "utf8"));
    const meshes = gltf.meshes || [];
    const accessors = gltf.accessors || [];
    const nodes = gltf.nodes || [];
    const drawnNodes = nodes.filter((node) => node.mesh !== undefined);

    const verticesPerMesh = meshes.map((mesh) =>
        mesh.primitives.reduce((total, primitive) => total + (accessors[primitive.attributes.POSITION]?.count || 0), 0));
    const drawnVertices = drawnNodes.reduce((total, node) => total + verticesPerMesh[node.mesh], 0);

    const folder = path.dirname(gltfPath);
    const bufferBytes = (gltf.buffers || [])
        .filter((buffer) => buffer.uri && !buffer.uri.startsWith("data:"))
        .reduce((total, buffer) => {
            const bufferPath = path.join(folder, decodeURIComponent(buffer.uri));
            return total + (fs.existsSync(bufferPath) ? fs.statSync(bufferPath).size : 0);
        }, 0);

    return {
        file: path.basename(gltfPath),
        nodes: nodes.length,
        drawnMeshNodes: drawnNodes.length,
        meshes: meshes.length,
        primitives: meshes.reduce((total, mesh) => total + mesh.primitives.length, 0),
        materials: (gltf.materials || []).length,
        textures: (gltf.textures || []).length,
        drawnVertices,
        sizeMegabytes: Number(((fs.statSync(gltfPath).size + bufferBytes) / BYTES_PER_MEGABYTE).toFixed(2)),
    };
}

const files = process.argv.slice(2);
if (files.length === 0) {
    process.stderr.write("Usage: node gltf-stats.mjs <scene.gltf> [more.gltf ...]\n");
    process.exit(1);
}
process.stdout.write(JSON.stringify(files.map(measure), null, 2) + "\n");
