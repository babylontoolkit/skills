/**
 * bt-optimize export stats: compares exported .gltf scenes — drawn mesh nodes, meshes, primitives (draw calls before
 * LOD selection), materials, textures, drawn vertices and the size on disk of the .gltf plus its buffers. Gzipped
 * exports (`.gz.gltf` / `.gz.bin`, detected by their magic bytes, not their names) are read too; each buffer reports
 * its size on disk and uncompressed.
 *
 * Usage:
 *   node gltf-stats.mjs export/scenes/original.gltf export/scenes/combined.gz.gltf
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** Bytes per megabyte, for readable sizes. */
const BYTES_PER_MEGABYTE = 1024 * 1024;

/** The two bytes every gzip stream starts with. */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Tells whether a file starts with the gzip magic bytes.
 * @param {string} filePath - path of the file to test
 * @returns {boolean} true when the file is a gzip stream
 */
function isGzipFile(filePath) {
    const header = Buffer.alloc(GZIP_MAGIC.length);
    const descriptor = fs.openSync(filePath, "r");
    try {
        fs.readSync(descriptor, header, 0, header.length, 0);
    } finally {
        fs.closeSync(descriptor);
    }
    return header[0] === GZIP_MAGIC[0] && header[1] === GZIP_MAGIC[1];
}

/**
 * Reads a .gltf file as JSON, gunzipping it first when it is gzipped.
 * @param {string} gltfPath - path of the .gltf (or .gz.gltf) file
 * @returns {object} the parsed glTF document
 */
function readGltf(gltfPath) {
    const raw = fs.readFileSync(gltfPath);
    const text = isGzipFile(gltfPath) ? zlib.gunzipSync(raw) : raw;
    return JSON.parse(text.toString("utf8"));
}

/**
 * Measures one external buffer: its size on disk and uncompressed. A gzipped buffer's uncompressed size is the
 * glTF's declared `byteLength` (what the loader gets after inflating it), so the file is never inflated here.
 * @param {string} folder - folder of the .gltf the buffer belongs to
 * @param {{uri: string, byteLength: number}} buffer - the glTF buffer entry
 * @returns {{uri: string, gzipped: boolean, diskBytes: number, uncompressedBytes: number}} the buffer's sizes (0 when missing)
 */
function measureBuffer(folder, buffer) {
    const bufferPath = path.join(folder, decodeURIComponent(buffer.uri));
    if (!fs.existsSync(bufferPath)) return { uri: buffer.uri, gzipped: false, diskBytes: 0, uncompressedBytes: 0 };
    const diskBytes = fs.statSync(bufferPath).size;
    const gzipped = isGzipFile(bufferPath);
    return { uri: buffer.uri, gzipped, diskBytes, uncompressedBytes: gzipped ? buffer.byteLength : diskBytes };
}

/**
 * Converts bytes to megabytes with two decimals.
 * @param {number} bytes - a size in bytes
 * @returns {number} the size in megabytes
 */
function toMegabytes(bytes) {
    return Number((bytes / BYTES_PER_MEGABYTE).toFixed(2));
}

/**
 * Reads one exported scene and measures it.
 * @param {string} gltfPath - path of the .gltf (or gzipped .gz.gltf) file
 * @returns {{file: string, gzipped: boolean, nodes: number, drawnMeshNodes: number, meshes: number, primitives: number,
 *   materials: number, textures: number, drawnVertices: number, sizeMegabytes: number, binMegabytesOnDisk: number,
 *   binMegabytesUncompressed: number, buffers: object[]}} the measurements (`sizeMegabytes` is the .gltf plus its buffers on disk)
 */
function measure(gltfPath) {
    const gltf = readGltf(gltfPath);
    const meshes = gltf.meshes || [];
    const accessors = gltf.accessors || [];
    const nodes = gltf.nodes || [];
    const drawnNodes = nodes.filter((node) => node.mesh !== undefined);

    const verticesPerMesh = meshes.map((mesh) =>
        mesh.primitives.reduce((total, primitive) => total + (accessors[primitive.attributes.POSITION]?.count || 0), 0));
    const drawnVertices = drawnNodes.reduce((total, node) => total + verticesPerMesh[node.mesh], 0);

    const folder = path.dirname(gltfPath);
    const buffers = (gltf.buffers || [])
        .filter((buffer) => buffer.uri && !buffer.uri.startsWith("data:"))
        .map((buffer) => measureBuffer(folder, buffer));
    const bufferDiskBytes = buffers.reduce((total, buffer) => total + buffer.diskBytes, 0);
    const bufferUncompressedBytes = buffers.reduce((total, buffer) => total + buffer.uncompressedBytes, 0);

    return {
        file: path.basename(gltfPath),
        gzipped: isGzipFile(gltfPath),
        nodes: nodes.length,
        drawnMeshNodes: drawnNodes.length,
        meshes: meshes.length,
        primitives: meshes.reduce((total, mesh) => total + mesh.primitives.length, 0),
        materials: (gltf.materials || []).length,
        textures: (gltf.textures || []).length,
        drawnVertices,
        sizeMegabytes: toMegabytes(fs.statSync(gltfPath).size + bufferDiskBytes),
        binMegabytesOnDisk: toMegabytes(bufferDiskBytes),
        binMegabytesUncompressed: toMegabytes(bufferUncompressedBytes),
        buffers,
    };
}

const files = process.argv.slice(2);
if (files.length === 0) {
    process.stderr.write("Usage: node gltf-stats.mjs <scene.gltf | scene.gz.gltf> [more ...]\n");
    process.exit(1);
}
process.stdout.write(JSON.stringify(files.map(measure), null, 2) + "\n");
