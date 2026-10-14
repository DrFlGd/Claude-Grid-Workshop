"""Small model files for the app tests (milestone 5): an STL, an OBJ and a 3MF with two colours, and a PNG."""
import struct, zipfile, pathlib

def cube(x0, y0, z0, s):
    v = [(x0+dx*s, y0+dy*s, z0+dz*s) for dz in (0,1) for dy in (0,1) for dx in (0,1)]
    f = [(0,2,1),(1,2,3),(4,5,6),(5,7,6),(0,1,4),(1,5,4),(2,6,3),(3,6,7),(0,4,2),(2,4,6),(1,3,5),(3,7,5)]
    return v, f

def write_stl(path, s=10):
    v, f = cube(0, 0, 0, s)
    out = bytearray(b"test part".ljust(80, b" ")) + struct.pack("<I", len(f))
    for a, b, c in f:
        out += struct.pack("<3f", 0, 0, 0) + b"".join(struct.pack("<3f", *v[i]) for i in (a, b, c)) + b"\0\0"
    pathlib.Path(path).write_bytes(bytes(out))

def write_obj(path, s=12):
    v, f = cube(0, 0, 0, s)
    pathlib.Path(path).write_text("".join(f"v {x} {y} {z}\n" for x, y, z in v) + "".join(f"f {a+1} {b+1} {c+1}\n" for a, b, c in f))

def write_3mf(path, png=None):
    """Two cubes in two colours (a base and a raised top), as a slicer writes them."""
    v1, f1 = cube(0, 0, 0, 10)
    v2, f2 = cube(2, 2, 10, 6)
    v = v1 + v2
    tris = [(a, b, c, 0) for a, b, c in f1] + [(a+8, b+8, c+8, 1) for a, b, c in f2]
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
             '<resources><basematerials id="1"><base name="Grey" displaycolor="#808080FF"/><base name="Red" displaycolor="#D02020FF"/></basematerials>'
             '<object id="2" type="model" pid="1" pindex="0"><mesh><vertices>'
             + "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in v) + '</vertices><triangles>'
             + "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}" pid="1" p1="{m}"/>' for a, b, c, m in tris)
             + '</triangles></mesh></object></resources><build><item objectid="2"/></build></model>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", model)
        if png:
            z.writestr("Metadata/thumbnail.png", png)

def png(w=8, h=6, rgb=(30, 120, 220)):
    import zlib
    raw = b"".join(b"\0" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
