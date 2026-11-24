import * as THREE from 'three';

// PASDA's public PEMA Cycle 2 cache. ArcGIS orders tiles as level / row / column.
const SERVICE = 'https://imagery.pasda.psu.edu/arcgis/rest/services/PEMAImagery_2021_2023_cache/MapServer';
const BASE = 14, MAX = 20, CONCURRENT = 4, CACHE = 140;
const tileX = (lon, n) => (lon + 180) / 360 * n;
const tileY = (lat, n) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
const latitude = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;

// Clip the existing terrain triangles, including their interpolated heights.
// This retains the exact community outline and prevents seams between tiles.
function clip(vertices, axis, edge, sign){
  const out = [];
  for (let i = 0; i < vertices.length; i++){
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    const da = sign * (a[axis] - edge), db = sign * (b[axis] - edge);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)){
      const t = da / (da - db);
      out.push(a.map((v, k) => v + (b[k] - v) * t));
    }
  }
  return out;
}

function cutGeometry(source, bounds, z, x, y, meta){
  const attr = source.attributes.position, ix = source.index;
  const count = ix ? ix.count : attr.count, pos = [], uv = [], n = 2 ** z;
  for (let i = 0; i < count; i += 3){
    let p = [0, 1, 2].map(k => {
      const j = ix ? ix.getX(i + k) : i + k;
      return [attr.getX(j), attr.getY(j), attr.getZ(j)];
    });
    if (Math.max(...p.map(v => v[0])) < bounds.min.x || Math.min(...p.map(v => v[0])) > bounds.max.x ||
        Math.max(...p.map(v => v[2])) < bounds.min.z || Math.min(...p.map(v => v[2])) > bounds.max.z) continue;
    p = clip(p, 0, bounds.min.x, 1); p = clip(p, 0, bounds.max.x, -1);
    p = clip(p, 2, bounds.min.z, 1); p = clip(p, 2, bounds.max.z, -1);
    for (let j = 1; j < p.length - 1; j++) for (const v of [p[0], p[j], p[j + 1]]){
      pos.push(...v);
      uv.push(tileX(meta.lon0 + v[0] / meta.kx, n) - x,
        1 - (tileY(meta.lat0 - v[2] / meta.kz, n) - y));
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  return geo;
}

export function createAerialLayer({scene, terrain, camera, renderer, meta, onStatus}){
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  terrain.geometry.computeBoundingBox();
  const full = terrain.geometry.boundingBox, roots = [], nodes = new Set();
  const frustum = new THREE.Frustum(), matrix = new THREE.Matrix4();
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  const originalMap = terrain.material.map;
  let active = false, running = 0, queue = [], last = -Infinity, stamp = 0, previousStatus = '';

  function makeNode(z, x, y, parent){
    const n = 2 ** z;
    const bounds = new THREE.Box3(
      new THREE.Vector3((x / n * 360 - 180 - meta.lon0) * meta.kx, full.min.y, (meta.lat0 - latitude(y, n)) * meta.kz),
      new THREE.Vector3(((x + 1) / n * 360 - 180 - meta.lon0) * meta.kx, full.max.y, (meta.lat0 - latitude(y + 1, n)) * meta.kz));
    if (!bounds.intersectsBox(full)) return null;
    const node = {z, x, y, bounds, parent, children: null, mesh: null, empty: false,
      state: 'idle', seen: 0, used: 0, error: false, controller: null};
    nodes.add(node); return node;
  }

  function ensureGeometry(node){
    if (node.mesh || node.empty) return;
    const source = node.parent ? node.parent.mesh.geometry : terrain.geometry;
    const geometry = cutGeometry(source, node.bounds, node.z, node.x, node.y, meta);
    if (!geometry){ node.empty = true; return; }
    const material = new THREE.MeshBasicMaterial({polygonOffset: true,
      polygonOffsetFactor: -(node.z - BASE + 1), polygonOffsetUnits: -(node.z - BASE + 1)});
    node.mesh = new THREE.Mesh(geometry, material);
    node.mesh.renderOrder = node.z - BASE + 1; node.mesh.visible = false;
    group.add(node.mesh);
  }

  function init(){
    if (roots.length) return;
    const n = 2 ** BASE;
    for (let y = Math.floor(tileY(meta.N, n)); y <= Math.floor(tileY(meta.S, n)); y++){
      for (let x = Math.floor(tileX(meta.W, n)); x <= Math.floor(tileX(meta.E, n)); x++){
        const node = makeNode(BASE, x, y, null);
        if (node) roots.push(node);
      }
    }
  }

  async function load(node){
    node.state = 'loading'; node.cancelled = false; running++;
    const controller = new AbortController(); node.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${SERVICE}/tile/${node.z}/${node.y}/${node.x}`, {signal: controller.signal});
      if (!response.ok) throw new Error(`Tile HTTP ${response.status}`);
      const blob = await response.blob();
      // Image decoding preserves Three.js's normal texture Y orientation.
      const url = URL.createObjectURL(blob), img = new Image();
      try { img.src = url; await img.decode(); } finally { URL.revokeObjectURL(url); }
      if (controller.signal.aborted) throw new Error('Tile cancelled');
      if (img.naturalWidth !== 256 || img.naturalHeight !== 256) throw new Error('Invalid imagery tile');
      const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); tex.needsUpdate = true;
      node.mesh.material.map = tex; node.mesh.material.needsUpdate = true;
      node.state = 'ready'; node.error = false;
    } catch {
      // Turning the layer off cancels work without recording a service failure.
      node.state = node.cancelled ? 'idle' : 'error'; node.error = !node.cancelled;
    } finally {
      clearTimeout(timeout); node.controller = null; running--; last = -Infinity;
      pump();
    }
  }

  function pump(){
    if (!active) return;
    while (running < CONCURRENT && queue.length){
      const node = queue.shift();
      if (node.state === 'idle' && node.seen === stamp) load(node);
    }
  }

  function visit(node, now, focal){
    if (!frustum.intersectsBox(node.bounds)) return;
    node.seen = stamp; node.used = now;
    ensureGeometry(node);
    if (node.empty) return;
    if (node.state === 'idle') queue.push(node);
    if (node.state !== 'ready') return;
    node.mesh.visible = true;
    node.bounds.getSize(size);
    const pixels = Math.max(size.x, size.z) * focal / Math.max(30, node.bounds.distanceToPoint(camera.position));
    if (node.z >= MAX || pixels < 320) return;
    if (!node.children){
      node.children = [];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++){
        const child = makeNode(node.z + 1, node.x * 2 + dx, node.y * 2 + dy, node);
        if (child) node.children.push(child);
      }
    }
    for (const child of node.children) visit(child, now, focal);
    // Parent photography stays beneath children until every visible child is ready.
    if (node.children.every(c => c.seen !== stamp || c.empty || c.state === 'ready')) node.mesh.visible = false;
  }

  function release(node){
    if (node.children){ for (const child of node.children) release(child); node.children = null; }
    node.controller?.abort();
    if (node.mesh){
      group.remove(node.mesh); node.mesh.material.map?.dispose();
      node.mesh.material.dispose(); node.mesh.geometry.dispose(); node.mesh = null;
    }
    nodes.delete(node);
  }

  function trim(){
    let loaded = [...nodes].filter(n => n.state === 'ready').length;
    if (loaded <= CACHE) return;
    // Evict whole inactive subtrees, leaving current parents/fallbacks intact.
    const candidates = [...nodes].filter(n => n.children && n.children.every(c => c.seen !== stamp))
      .sort((a, b) => a.used - b.used);
    for (const node of candidates){
      if (loaded <= CACHE) break;
      if (!nodes.has(node) || !node.children) continue;
      for (const child of node.children) release(child);
      node.children = null;
      loaded = [...nodes].filter(n => n.state === 'ready').length;
    }
  }

  function update(now){
    if (!active || now - last < 180) return;
    last = now; stamp++; queue = [];
    camera.updateMatrixWorld(); matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(matrix);
    for (const node of nodes) if (node.mesh) node.mesh.visible = false;
    const focal = renderer.domElement.clientHeight / (2 * Math.tan(camera.fov * Math.PI / 360)) * Math.min(renderer.getPixelRatio(), 1.5);
    for (const node of roots) visit(node, now, focal);
    queue.sort((a, b) => a.z - b.z || a.bounds.getCenter(center).distanceToSquared(camera.position) - b.bounds.getCenter(size).distanceToSquared(camera.position));
    pump(); trim();
    const visible = [...nodes].filter(n => n.seen === stamp && !n.empty);
    const errors = visible.some(n => n.error);
    const loading = visible.some(n => n.state === 'loading' || n.state === 'idle');
    const ready = visible.some(n => n.state === 'ready');
    const status = errors ? (ready ? 'partial' : 'error') : loading ? 'loading' : 'ready';
    if (status !== previousStatus){ previousStatus = status; onStatus(status); }
  }

  return {
    update,
    setActive(value){
      active = value; group.visible = value; last = -Infinity; previousStatus = '';
      if (value){
        init();
        for (const node of nodes) if (node.state === 'error'){ node.state = 'idle'; node.error = false; }
        // A neutral base makes missing photography clear; illustrations are never presented as aerial imagery.
        terrain.material.map = null; terrain.material.color.set('#b5b8a6');
        onStatus('loading');
      } else {
        queue = [];
        for (const node of nodes) if (node.controller){ node.cancelled = true; node.controller.abort(); }
        terrain.material.map = originalMap; terrain.material.color.set('#ffffff');
      }
      terrain.material.needsUpdate = true;
    },
    getStats(){
      return {active, tiles: nodes.size, loaded: [...nodes].filter(n => n.state === 'ready').length,
        visible: [...nodes].filter(n => n.mesh?.visible).length, running,
        maxZoom: Math.max(BASE, ...[...nodes].filter(n => n.mesh?.visible).map(n => n.z))};
    }
  };
}
