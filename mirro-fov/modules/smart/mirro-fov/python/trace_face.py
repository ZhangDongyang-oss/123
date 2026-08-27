"""反向追踪: 找包含曲线 #270368 的 ADVANCED_FACE"""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import step_curve_sampler as scs
import step_topology as st

step_file = r"STEP_FILE_PLACEHOLDER.stp"
entities, points = scs.parse_step(step_file)

targets = [270368, 174205]  # 两条主边界曲线

for target in targets:
    print(f"\n{'='*60}\n追踪几何曲线 #{target} 所属的 ADVANCED_FACE\n{'='*60}")
    # 1. EDGE_CURVE 引用 #target
    ec_refs = [eid for eid, (t, a) in entities.items() if t == 'EDGE_CURVE' and f'#{target}' in a]
    print(f"1. EDGE_CURVE 引用 #{target}: {ec_refs}")
    if not ec_refs:
        continue
    # 2. ORIENTED_EDGE 引用这些 EDGE_CURVE
    oe_refs = [eid for eid, (t, a) in entities.items()
               if t == 'ORIENTED_EDGE' and any(f'#{ec}' in a for ec in ec_refs)]
    print(f"2. ORIENTED_EDGE: {oe_refs[:5]}{'...' if len(oe_refs)>5 else ''} ({len(oe_refs)} 个)")
    # 3. EDGE_LOOP 引用这些 ORIENTED_EDGE
    loop_refs = [eid for eid, (t, a) in entities.items()
                 if t == 'EDGE_LOOP' and any(f'#{oe}' in a for oe in oe_refs)]
    print(f"3. EDGE_LOOP: {loop_refs}")
    # 4. FACE_BOUND 引用这些 LOOP
    bound_refs = [eid for eid, (t, a) in entities.items()
                  if t in ('FACE_BOUND', 'FACE_OUTER_BOUND') and any(f'#{lp}' in a for lp in loop_refs)]
    print(f"4. FACE_BOUND: {bound_refs}")
    # 5. ADVANCED_FACE 引用这些 BOUND
    faces = []
    for eid, (t, a) in entities.items():
        if t != 'ADVANCED_FACE':
            continue
        if any(f'#{b}' in a for b in bound_refs):
            tokens = scs._split_top_level(a)
            name = st._decode_step_name(tokens[0].strip().strip("'")) if tokens else '?'
            faces.append((eid, name))
    print(f"5. ADVANCED_FACE: {faces[:5]}")
    for fid, name in faces[:3]:
        # 采样这个面的完整边界
        fb = next((b for f_id, n, b, _ in st.find_mirror_faces(entities) if f_id == fid), None)
        if fb is None:
            # 不在 lens 名字里, 手动取 bounds
            tokens = scs._split_top_level(entities[fid][1])
            fb = scs._parse_ref_list(tokens[1]) if len(tokens) > 1 else []
        edges = st.trace_face_boundary(fid, fb, entities)
        all_pts = []
        for edge in edges:
            p, _ = st.sample_edge_curve(edge, entities, points, 10)
            if p is not None:
                all_pts.extend([[float(x[0]), float(x[1]), float(x[2])] for x in p])
        if all_pts:
            import numpy as np
            arr = np.array(all_pts)
            print(f"   #{fid} {name!r}: {len(edges)} 边, {len(all_pts)} 点")
            print(f"     X:{arr[:,0].min():.1f}~{arr[:,0].max():.1f}(跨{np.ptp(arr[:,0]):.1f}) "
                  f"Y:{arr[:,1].min():.1f}~{arr[:,1].max():.1f}(跨{np.ptp(arr[:,1]):.1f}) "
                  f"Z:{arr[:,2].min():.1f}~{arr[:,2].max():.1f}(跨{np.ptp(arr[:,2]):.1f})")
