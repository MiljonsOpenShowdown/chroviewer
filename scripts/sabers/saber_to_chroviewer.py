"""Convert Beat Saber .saber files (Unity asset bundles) for ChroViewer's
custom-saber loader (src/renderer/replay/custom-saber.ts).

Drop one or more .saber files on the built exe, or run:
    python -I scripts/sabers/saber_to_chroviewer.py <file.saber> [...]

Next to each .saber it writes a folder laid out like public/sabers/:
    <id>-chroviewer/models/<id>.glb
    <id>-chroviewer/textures/<id>-trail.png
    <id>-chroviewer/chroviewer-entries.txt   (the code entries to add)

GLB layout the loader expects:
- nodes named Left__<object>__<material>__<index> or Right__..., vertices baked
  into the LeftSaber/RightSaber space, x mirrored (Unity is left-handed). Checked
  against the existing euc.glb: identical triangles and winding.
- materials named <material>::<role>, role from the Unity material:
  custom-glow / static-glow / custom-surface / surface
- parts sharing a side and material merge into one mesh (one draw call each)

The trail texture is the trail material's _AlphaTex (else its first texture),
saved unchanged. Saber animations and special shaders (e.g. fire trail
displacement) are not converted.

Build the exe (any venv):
    pip install UnityPy trimesh numpy pyinstaller
    pyinstaller --onefile --name SaberToChroViewer --collect-all UnityPy
        --collect-all trimesh scripts/sabers/saber_to_chroviewer.py
"""

import os
import re
import sys
import traceback

import numpy as np
import trimesh
import UnityPy
from PIL import Image
from UnityPy.helpers.MeshHelper import MeshHandler

SABER_ROOTS = (('Left', 'LeftSaber'), ('Right', 'RightSaber'))
TRAIL_TEXTURE_SLOTS = ('_AlphaTex', '_MainTex', '_Texture')


def trs(transform):
    p, r, s = transform.m_LocalPosition, transform.m_LocalRotation, transform.m_LocalScale
    x, y, z, w = r.x, r.y, r.z, r.w
    rot = np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )
    m = np.eye(4)
    m[:3, :3] = rot * np.array([s.x, s.y, s.z])
    m[:3, 3] = [p.x, p.y, p.z]
    return m


def props(material):
    saved = material.m_SavedProperties
    floats = dict(saved.m_Floats) if saved.m_Floats else {}
    colors = dict(saved.m_Colors) if saved.m_Colors else {}
    textures = dict(saved.m_TexEnvs) if saved.m_TexEnvs else {}
    return floats, colors, textures


def shader_name(material):
    try:
        shader = material.m_Shader.read()
    except Exception:
        return ''
    parsed = getattr(shader, 'm_ParsedForm', None)
    return getattr(parsed, 'm_Name', None) or getattr(shader, 'm_Name', '') or ''


def role(material):
    floats, _, _ = props(material)
    if '_CustomColors' in floats:
        custom = floats['_CustomColors'] >= 0.5
    else:
        # Without the property, the Beat Saber glow shaders use the player's
        # colors unless they are the "(No CC)" variants (checked on CG5)
        custom = 'No CC' not in shader_name(material)
    glow = floats.get('_Glow', 0) > 0
    if custom and glow:
        return 'custom-glow'
    if glow:
        return 'static-glow'
    return 'custom-surface' if custom else 'surface'


def slug(name):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', name.lower())).strip('-') or 'saber'


def ts_key(model_id):
    return model_id if re.fullmatch(r'[a-z_$][a-z0-9_$]*', model_id) else f"'{model_id}'"


def convert(source):
    env = UnityPy.load(source)
    transforms = {o.path_id: o.read() for o in env.objects if o.type.name == 'Transform'}
    trees = []
    for o in env.objects:
        if o.type.name == 'MonoBehaviour':
            try:
                trees.append(o.read_typetree())
            except Exception:
                pass

    descriptor = next((t for t in trees if 'SaberName' in t), {})
    display_name = (descriptor.get('SaberName') or '').strip() or os.path.splitext(os.path.basename(source))[0]
    model_id = slug(display_name)

    def name_of(transform):
        return transform.m_GameObject.read().m_Name

    roots = {}
    for side, root_name in SABER_ROOTS:
        root = next((t for t in transforms.values() if name_of(t) == root_name), None)
        if root is None:
            raise ValueError(f'no {root_name} object in this .saber')
        roots[side] = root

    scene = trimesh.Scene()
    materials = {}
    parts = {}

    def emit(side, object_name, mesh, renderer, matrix):
        handler = MeshHandler(mesh)
        handler.process()
        count = handler.m_VertexCount

        def channel(values, size):
            # Unity may store more components per vertex (e.g. 4 for normals)
            if not values:
                return None
            return np.array(values, dtype=np.float64).reshape(count, -1)[:, :size]

        vertices = channel(handler.m_Vertices, 3)
        if vertices is None:
            return
        normals = channel(handler.m_Normals, 3)
        uvs = channel(handler.m_UV0, 2)
        world = (matrix[:3, :3] @ vertices.T).T + matrix[:3, 3]
        if normals is not None:
            normals = (np.linalg.inv(matrix[:3, :3]).T @ normals.T).T
            normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
        # Unity is left-handed, glTF right-handed
        world[:, 0] *= -1
        if normals is not None:
            normals[:, 0] *= -1
        for index, triangles in enumerate(handler.get_triangles()):
            if index >= len(renderer.m_Materials) or not renderer.m_Materials[index].path_id:
                continue
            unity_material = renderer.m_Materials[index].read()
            faces = np.array(triangles, dtype=np.int64).reshape(-1, 3)[:, ::-1]
            if len(faces) == 0:
                continue
            used = np.unique(faces)
            remap = -np.ones(len(world), dtype=np.int64)
            remap[used] = np.arange(len(used))
            key = unity_material.m_Name
            if key not in materials:
                _, colors, _ = props(unity_material)
                color = colors.get('_Color')
                base = [color.r, color.g, color.b, 1.0] if color is not None else [0.8, 0.8, 0.8, 1.0]
                materials[key] = trimesh.visual.material.PBRMaterial(
                    name=f'{key}::{role(unity_material)}',
                    baseColorFactor=base,
                    metallicFactor=0.2,
                    roughnessFactor=0.55,
                )
            part = trimesh.Trimesh(
                vertices=world[used],
                faces=remap[faces],
                vertex_normals=None if normals is None else normals[used],
                process=False,
            )
            part.visual = trimesh.visual.TextureVisuals(uv=None if uvs is None else uvs[used], material=materials[key])
            parts.setdefault((side, key), []).append((object_name, part))

    def walk(side, transform, matrix):
        game_object = transform.m_GameObject.read()
        if not game_object.m_IsActive:
            return
        mesh_filter = renderer = None
        for component in game_object.m_Component:
            pointer = component.component if hasattr(component, 'component') else component
            try:
                obj = pointer.read()
            except Exception:
                continue
            kind = obj.object_reader.type.name
            if kind == 'MeshFilter':
                mesh_filter = obj
            elif kind == 'MeshRenderer' and obj.m_Enabled:
                renderer = obj
        if mesh_filter is not None and renderer is not None and mesh_filter.m_Mesh.path_id:
            emit(side, game_object.m_Name, mesh_filter.m_Mesh.read(), renderer, matrix)
        for child in transform.m_Children:
            child_transform = child.read()
            walk(side, child_transform, matrix @ trs(child_transform))

    for side, root in roots.items():
        for child in root.m_Children:
            child_transform = child.read()
            walk(side, child_transform, trs(child_transform))
    if not parts:
        raise ValueError('no meshes found under LeftSaber/RightSaber')

    for index, ((side, key), entries) in enumerate(parts.items()):
        merged = entries[0][1] if len(entries) == 1 else trimesh.util.concatenate([part for _, part in entries])
        merged.visual.material = materials[key]
        object_name = entries[0][0] if len(entries) == 1 else 'merged'
        name = f'{side}__{object_name}__{key}__{index}'.replace(' ', '_')
        scene.add_geometry(merged, node_name=name, geom_name=name)

    # Trail: points along the blade in saber space, and the trail material's texture
    root_ids = {root.m_GameObject.path_id for root in roots.values()}

    def saber_z(transform):
        matrix = np.eye(4)
        current = transform
        while current is not None and current.m_GameObject.path_id not in root_ids:
            matrix = trs(current) @ matrix
            father = current.m_Father
            current = transforms.get(father.path_id) if father and father.path_id else None
        return float(matrix[2, 3])

    trail = next((t for t in trees if 'PointStart' in t and 'PointEnd' in t), None)
    base = tip = None
    trail_texture = None
    if trail is not None:
        zs = []
        for key in ('PointStart', 'PointEnd'):
            pointer = trail[key].get('m_PathID')
            if pointer in transforms:
                zs.append(saber_z(transforms[pointer]))
        if len(zs) == 2:
            base, tip = min(zs), max(zs)
        material_pointer = (trail.get('TrailMaterial') or {}).get('m_PathID')
        trail_material = next(
            (o.read() for o in env.objects if o.path_id == material_pointer and o.type.name == 'Material'), None
        )
        if trail_material is not None:
            _, _, slots = props(trail_material)
            ordered = [slots[s] for s in TRAIL_TEXTURE_SLOTS if s in slots] + list(slots.values())
            for slot in ordered:
                if slot.m_Texture and slot.m_Texture.path_id:
                    trail_texture = slot.m_Texture.read().image
                    break

    out_dir = os.path.join(os.path.dirname(os.path.abspath(source)), f'{model_id}-chroviewer')
    os.makedirs(os.path.join(out_dir, 'models'), exist_ok=True)
    os.makedirs(os.path.join(out_dir, 'textures'), exist_ok=True)
    glb_path = os.path.join(out_dir, 'models', f'{model_id}.glb')
    scene.export(glb_path)
    texture_path = os.path.join(out_dir, 'textures', f'{model_id}-trail.png')
    warnings = []
    if trail_texture is None:
        # A plain white trail rather than a missing file
        trail_texture = Image.new('RGBA', (64, 64), (255, 255, 255, 255))
        warnings.append('No trail texture found: wrote a plain white one.')
    trail_texture.save(texture_path)
    if base is None:
        base, tip = 0.5, 1.0
        warnings.append('No CustomTrail found: used base 0.5 / tip 1.0.')

    key = ts_key(model_id)
    entries = f"""ChroViewer entries for "{display_name}" (id: {model_id})

1. Copy models/{model_id}.glb   -> public/sabers/models/
   Copy textures/{model_id}-trail.png -> public/sabers/textures/

2. src/core/viewer-settings.ts, replaySaberModelIds:
  '{model_id}',

3. src/renderer/replay/custom-saber.ts, MODEL_PATHS:
  {key}: '{model_id}.glb',

   MODEL_TRAILS:
  {key}: {{
    base: {base:.9g},
    tip: {tip:.9g},
    texture: '{model_id}-trail.png',
  }},

4. src/i18n/messages/en.json, settings.saber.saberModels:
        "{model_id}": "{display_name}"

5. Use it: saberModel '{model_id}' (overlay-defaults.ts, or MOS tile/URL settings)
"""
    if warnings:
        entries += '\nWarnings:\n' + '\n'.join(f'- {w}' for w in warnings) + '\n'
    with open(os.path.join(out_dir, 'chroviewer-entries.txt'), 'w', encoding='utf-8') as file:
        file.write(entries)
    return out_dir, entries, [m.name for m in materials.values()]


def main():
    paths = [p for p in sys.argv[1:] if not p.startswith('--')]
    if not paths:
        print('Drag one or more .saber files onto this program.')
    failed = False
    for path in paths:
        print(f'=== {os.path.basename(path)}')
        try:
            out_dir, entries, material_names = convert(path)
            print(f'Materials: {", ".join(material_names)}')
            print(f'Wrote {out_dir}\n')
            print(entries)
        except Exception as error:
            failed = True
            print(f'FAILED: {error}')
            traceback.print_exc()
    if '--no-pause' not in sys.argv:
        input('Press Enter to close...')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
