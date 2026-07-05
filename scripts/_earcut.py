"""Pure-Python earcut polygon triangulation (RENDERMODEL-4).

A faithful, dependency-free port of the mapbox/earcut algorithm (ISC license,
https://github.com/mapbox/earcut). Handles concave polygons and holes, which the
downstream C++ render_artifact_compiler cannot (it fans each ring, convex-only).

We use it in stage-1 to pre-triangulate real ENC area features (DEPARE/LNDARE/
DRGARE) into triangles, then hand each triangle to the compiler as a 3-point
convex ring. No numpy / GDAL bindings required so the capture is reproducible.

    earcut(data, hole_indices=None, dim=2) -> list[int]
        data: flat [x0,y0, x1,y1, ...] vertex coords.
        hole_indices: start vertex index of each hole ring (in vertex units).
        returns a flat list of triangle vertex indices (into `data` points).
"""
from __future__ import annotations

import math


class _Node:
    __slots__ = ("i", "x", "y", "prev", "next", "z", "prevZ", "nextZ", "steiner")

    def __init__(self, i, x, y):
        self.i = i
        self.x = x
        self.y = y
        self.prev = None
        self.next = None
        self.z = 0
        self.prevZ = None
        self.nextZ = None
        self.steiner = False


def earcut(data, hole_indices=None, dim=2):
    has_holes = bool(hole_indices)
    outer_len = hole_indices[0] * dim if has_holes else len(data)
    outer_node = _linked_list(data, 0, outer_len, dim, True)
    triangles = []

    if outer_node is None or outer_node.next is outer_node.prev:
        return triangles

    if has_holes:
        outer_node = _eliminate_holes(data, hole_indices, outer_node, dim)

    min_x = min_y = inv_size = 0.0
    use_z = len(data) > 80 * dim
    if use_z:
        min_x = max_x = data[0]
        min_y = max_y = data[1]
        for i in range(dim, outer_len, dim):
            x = data[i]
            y = data[i + 1]
            if x < min_x:
                min_x = x
            if y < min_y:
                min_y = y
            if x > max_x:
                max_x = x
            if y > max_y:
                max_y = y
        inv_size = max(max_x - min_x, max_y - min_y)
        inv_size = 32767.0 / inv_size if inv_size != 0 else 0.0

    _earcut_linked(outer_node, triangles, dim, min_x, min_y, inv_size, 0)
    return triangles


def _linked_list(data, start, end, dim, clockwise):
    last = None
    if clockwise == (_signed_area(data, start, end, dim) > 0):
        for i in range(start, end, dim):
            last = _insert_node(i // dim, data[i], data[i + 1], last)
    else:
        for i in range(end - dim, start - 1, -dim):
            last = _insert_node(i // dim, data[i], data[i + 1], last)
    if last is not None and _equals(last, last.next):
        _remove_node(last)
        last = last.next
    return last


def _filter_points(start, end=None):
    if start is None:
        return start
    if end is None:
        end = start
    p = start
    while True:
        again = False
        if not p.steiner and (_equals(p, p.next) or _area(p.prev, p, p.next) == 0):
            _remove_node(p)
            p = end = p.prev
            if p is p.next:
                break
            again = True
        else:
            p = p.next
        if not again and p is end:
            break
    return end


def _earcut_linked(ear, triangles, dim, min_x, min_y, inv_size, pass_num):
    if ear is None:
        return
    if pass_num == 0 and inv_size:
        _index_curve(ear, min_x, min_y, inv_size)

    stop = ear
    while ear.prev is not ear.next:
        prev = ear.prev
        nxt = ear.next

        is_ear = _is_ear_hashed(ear, min_x, min_y, inv_size) if inv_size else _is_ear(ear)
        if is_ear:
            triangles.append(prev.i)
            triangles.append(ear.i)
            triangles.append(nxt.i)
            _remove_node(ear)
            ear = nxt.next
            stop = nxt.next
            continue

        ear = nxt
        if ear is stop:
            if pass_num == 0:
                _earcut_linked(_filter_points(ear), triangles, dim, min_x, min_y, inv_size, 1)
            elif pass_num == 1:
                ear = _cure_local_intersections(_filter_points(ear), triangles)
                _earcut_linked(ear, triangles, dim, min_x, min_y, inv_size, 2)
            elif pass_num == 2:
                _split_earcut(ear, triangles, dim, min_x, min_y, inv_size)
            break


def _is_ear(ear):
    a = ear.prev
    b = ear
    c = ear.next
    if _area(a, b, c) >= 0:
        return False
    ax, ay, bx, by, cx, cy = a.x, a.y, b.x, b.y, c.x, c.y
    x0 = min(ax, bx, cx)
    y0 = min(ay, by, cy)
    x1 = max(ax, bx, cx)
    y1 = max(ay, by, cy)
    p = c.next
    while p is not a:
        if (x0 <= p.x <= x1 and y0 <= p.y <= y1 and
                _point_in_triangle(ax, ay, bx, by, cx, cy, p.x, p.y) and
                _area(p.prev, p, p.next) >= 0):
            return False
        p = p.next
    return True


def _is_ear_hashed(ear, min_x, min_y, inv_size):
    a = ear.prev
    b = ear
    c = ear.next
    if _area(a, b, c) >= 0:
        return False
    ax, ay, bx, by, cx, cy = a.x, a.y, b.x, b.y, c.x, c.y
    x0 = min(ax, bx, cx)
    y0 = min(ay, by, cy)
    x1 = max(ax, bx, cx)
    y1 = max(ay, by, cy)
    min_z = _z_order(x0, y0, min_x, min_y, inv_size)
    max_z = _z_order(x1, y1, min_x, min_y, inv_size)

    p = ear.prevZ
    n = ear.nextZ
    while p is not None and p.z >= min_z and n is not None and n.z <= max_z:
        if (p is not ear.prev and p is not ear.next and
                _point_in_triangle(ax, ay, bx, by, cx, cy, p.x, p.y) and
                _area(p.prev, p, p.next) >= 0):
            return False
        p = p.prevZ
        if (n is not ear.prev and n is not ear.next and
                _point_in_triangle(ax, ay, bx, by, cx, cy, n.x, n.y) and
                _area(n.prev, n, n.next) >= 0):
            return False
        n = n.nextZ

    while p is not None and p.z >= min_z:
        if (p is not ear.prev and p is not ear.next and
                _point_in_triangle(ax, ay, bx, by, cx, cy, p.x, p.y) and
                _area(p.prev, p, p.next) >= 0):
            return False
        p = p.prevZ

    while n is not None and n.z <= max_z:
        if (n is not ear.prev and n is not ear.next and
                _point_in_triangle(ax, ay, bx, by, cx, cy, n.x, n.y) and
                _area(n.prev, n, n.next) >= 0):
            return False
        n = n.nextZ

    return True


def _cure_local_intersections(start, triangles):
    p = start
    while True:
        a = p.prev
        b = p.next.next
        if (not _equals(a, b) and _intersects(a, p, p.next, b) and
                _locally_inside(a, b) and _locally_inside(b, a)):
            triangles.append(a.i)
            triangles.append(p.i)
            triangles.append(b.i)
            _remove_node(p)
            _remove_node(p.next)
            p = start = b
        p = p.next
        if p is start:
            break
    return _filter_points(p)


def _split_earcut(start, triangles, dim, min_x, min_y, inv_size):
    a = start
    while True:
        b = a.next.next
        while b is not a.prev:
            if a.i != b.i and _is_valid_diagonal(a, b):
                c = _split_polygon(a, b)
                a = _filter_points(a, a.next)
                c = _filter_points(c, c.next)
                _earcut_linked(a, triangles, dim, min_x, min_y, inv_size, 0)
                _earcut_linked(c, triangles, dim, min_x, min_y, inv_size, 0)
                return
            b = b.next
        a = a.next
        if a is start:
            break


def _eliminate_holes(data, hole_indices, outer_node, dim):
    queue = []
    n = len(hole_indices)
    for i in range(n):
        start = hole_indices[i] * dim
        end = hole_indices[i + 1] * dim if i < n - 1 else len(data)
        lst = _linked_list(data, start, end, dim, False)
        if lst is lst.next:
            lst.steiner = True
        queue.append(_get_leftmost(lst))
    queue.sort(key=lambda node: node.x)
    for node in queue:
        outer_node = _eliminate_hole(node, outer_node)
    return outer_node


def _eliminate_hole(hole, outer_node):
    bridge = _find_hole_bridge(hole, outer_node)
    if bridge is None:
        return outer_node
    bridge_reverse = _split_polygon(bridge, hole)
    _filter_points(bridge_reverse, bridge_reverse.next)
    return _filter_points(bridge, bridge.next)


def _find_hole_bridge(hole, outer_node):
    p = outer_node
    hx = hole.x
    hy = hole.y
    qx = -math.inf
    m = None
    while True:
        if hy <= p.y and hy >= p.next.y and p.next.y != p.y:
            x = p.x + (hy - p.y) / (p.next.y - p.y) * (p.next.x - p.x)
            if x <= hx and x > qx:
                qx = x
                m = p if p.x < p.next.x else p.next
                if x == hx:
                    return m
        p = p.next
        if p is outer_node:
            break
    if m is None:
        return None
    stop = m
    mx = m.x
    my = m.y
    tan_min = math.inf
    p = m
    while True:
        if (hx >= p.x >= mx and hx != p.x and
                _point_in_triangle(hx if hy < my else qx, hy, mx, my, qx if hy < my else hx, hy, p.x, p.y)):
            tan = abs(hy - p.y) / (hx - p.x)
            if _locally_inside(p, hole) and (tan < tan_min or (tan == tan_min and (p.x > m.x or (p.x == m.x and _sector_contains(m, p))))):
                m = p
                tan_min = tan
        p = p.next
        if p is stop:
            break
    return m


def _sector_contains(m, p):
    return _area(m.prev, m, p.prev) < 0 and _area(p.next, m, m.next) < 0


def _index_curve(start, min_x, min_y, inv_size):
    p = start
    while True:
        if p.z == 0:
            p.z = _z_order(p.x, p.y, min_x, min_y, inv_size)
        p.prevZ = p.prev
        p.nextZ = p.next
        p = p.next
        if p is start:
            break
    p.prevZ.nextZ = None
    p.prevZ = None
    _sort_linked(p)


def _sort_linked(head):
    in_size = 1
    while True:
        p = head
        head = None
        tail = None
        num_merges = 0
        while p is not None:
            num_merges += 1
            q = p
            p_size = 0
            for _ in range(in_size):
                p_size += 1
                q = q.nextZ
                if q is None:
                    break
            q_size = in_size
            while p_size > 0 or (q_size > 0 and q is not None):
                if p_size != 0 and (q_size == 0 or q is None or p.z <= q.z):
                    e = p
                    p = p.nextZ
                    p_size -= 1
                else:
                    e = q
                    q = q.nextZ
                    q_size -= 1
                if tail is not None:
                    tail.nextZ = e
                else:
                    head = e
                e.prevZ = tail
                tail = e
            p = q
        tail.nextZ = None
        in_size *= 2
        if num_merges <= 1:
            break
    return head


def _z_order(x, y, min_x, min_y, inv_size):
    x = int((x - min_x) * inv_size) & 0xFFFF
    y = int((y - min_y) * inv_size) & 0xFFFF
    x = (x | (x << 8)) & 0x00FF00FF
    x = (x | (x << 4)) & 0x0F0F0F0F
    x = (x | (x << 2)) & 0x33333333
    x = (x | (x << 1)) & 0x55555555
    y = (y | (y << 8)) & 0x00FF00FF
    y = (y | (y << 4)) & 0x0F0F0F0F
    y = (y | (y << 2)) & 0x33333333
    y = (y | (y << 1)) & 0x55555555
    return x | (y << 1)


def _get_leftmost(start):
    p = start
    leftmost = start
    while True:
        if p.x < leftmost.x or (p.x == leftmost.x and p.y < leftmost.y):
            leftmost = p
        p = p.next
        if p is start:
            break
    return leftmost


def _point_in_triangle(ax, ay, bx, by, cx, cy, px, py):
    return ((cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 and
            (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 and
            (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0)


def _is_valid_diagonal(a, b):
    return (a.next.i != b.i and a.prev.i != b.i and
            not _intersects_polygon(a, b) and
            ((_locally_inside(a, b) and _locally_inside(b, a) and _middle_inside(a, b) and
              (_area(a.prev, a, b.prev) != 0 or _area(a, b.prev, b) != 0)) or
             (_equals(a, b) and _area(a.prev, a, a.next) > 0 and _area(b.prev, b, b.next) > 0)))


def _area(p, q, r):
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)


def _equals(p1, p2):
    return p1.x == p2.x and p1.y == p2.y


def _intersects(p1, q1, p2, q2):
    o1 = _sign(_area(p1, q1, p2))
    o2 = _sign(_area(p1, q1, q2))
    o3 = _sign(_area(p2, q2, p1))
    o4 = _sign(_area(p2, q2, q1))
    if o1 != o2 and o3 != o4:
        return True
    if o1 == 0 and _on_segment(p1, p2, q1):
        return True
    if o2 == 0 and _on_segment(p1, q2, q1):
        return True
    if o3 == 0 and _on_segment(p2, p1, q2):
        return True
    if o4 == 0 and _on_segment(p2, q1, q2):
        return True
    return False


def _on_segment(p, q, r):
    return (min(p.x, r.x) <= q.x <= max(p.x, r.x) and
            min(p.y, r.y) <= q.y <= max(p.y, r.y))


def _sign(num):
    return (num > 0) - (num < 0)


def _intersects_polygon(a, b):
    p = a
    while True:
        if (p.i != a.i and p.next.i != a.i and p.i != b.i and p.next.i != b.i and
                _intersects(p, p.next, a, b)):
            return True
        p = p.next
        if p is a:
            break
    return False


def _locally_inside(a, b):
    if _area(a.prev, a, a.next) < 0:
        return _area(a, b, a.next) >= 0 and _area(a, a.prev, b) >= 0
    return _area(a, b, a.prev) < 0 or _area(a, a.next, b) < 0


def _middle_inside(a, b):
    p = a
    inside = False
    px = (a.x + b.x) / 2
    py = (a.y + b.y) / 2
    while True:
        if ((p.y > py) != (p.next.y > py) and p.next.y != p.y and
                px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x):
            inside = not inside
        p = p.next
        if p is a:
            break
    return inside


def _split_polygon(a, b):
    a2 = _Node(a.i, a.x, a.y)
    b2 = _Node(b.i, b.x, b.y)
    an = a.next
    bp = b.prev
    a.next = b
    b.prev = a
    a2.next = an
    an.prev = a2
    b2.next = a2
    a2.prev = b2
    bp.next = b2
    b2.prev = bp
    return b2


def _insert_node(i, x, y, last):
    p = _Node(i, x, y)
    if last is None:
        p.prev = p
        p.next = p
    else:
        p.next = last.next
        p.prev = last
        last.next.prev = p
        last.next = p
    return p


def _remove_node(p):
    p.next.prev = p.prev
    p.prev.next = p.next
    if p.prevZ is not None:
        p.prevZ.nextZ = p.nextZ
    if p.nextZ is not None:
        p.nextZ.prevZ = p.prevZ


def _signed_area(data, start, end, dim):
    total = 0.0
    j = end - dim
    for i in range(start, end, dim):
        total += (data[j] - data[i]) * (data[i + 1] + data[j + 1])
        j = i
    return total


def triangulate_rings(exterior, holes):
    """Triangulate one polygon (exterior + hole rings of [x,y] points).

    Returns a list of triangles, each a list of three [x,y] points.
    Rings must NOT be closed (no duplicated last==first point); we drop a
    trailing duplicate if present.
    """
    def clean(ring):
        r = list(ring)
        if len(r) >= 2 and r[0][0] == r[-1][0] and r[0][1] == r[-1][1]:
            r = r[:-1]
        return r

    ext = clean(exterior)
    if len(ext) < 3:
        return []
    data = []
    for x, y in ext:
        data.append(float(x))
        data.append(float(y))
    hole_indices = []
    for hole in holes or []:
        h = clean(hole)
        if len(h) < 3:
            continue
        hole_indices.append(len(data) // 2)
        for x, y in h:
            data.append(float(x))
            data.append(float(y))
    idx = earcut(data, hole_indices if hole_indices else None, 2)
    tris = []
    for k in range(0, len(idx) - 2, 3):
        a = idx[k]
        b = idx[k + 1]
        c = idx[k + 2]
        tris.append([
            [data[a * 2], data[a * 2 + 1]],
            [data[b * 2], data[b * 2 + 1]],
            [data[c * 2], data[c * 2 + 1]],
        ])
    return tris
