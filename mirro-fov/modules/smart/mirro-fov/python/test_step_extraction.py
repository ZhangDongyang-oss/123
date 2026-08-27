#!/usr/bin/env python3
"""
STEP 提取回归测试 — 共享提取质量防线
====================================
覆盖: 自检闸门 (断点/闭合) / 重复描边清理 / 半模镜像 / 真实文件集成 (文件缺失时跳过)。

用法: python python/test_step_extraction.py
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import numpy as np  # noqa: E402

import step_verify  # noqa: E402
import step_topology as st  # noqa: E402
import step_rear_window as rw  # noqa: E402

TMP = Path(__file__).parent.parent / 'data' / 'tmp'
PY = Path(__file__).parent


def test_gate_detects_breaks():
    """闸门应抓住飞线断点 (自适应阈值)"""
    pts = [[0, 0, 0], [10, 0, 0], [20, 0, 0], [30, 0, 0], [500, 0, 0], [31, 0, 0]]
    try:
        step_verify.assert_outline_ok(pts, 'test')
        raise AssertionError('应抛出断点错误')
    except ValueError as e:
        assert '断点' in str(e), str(e)
    print('  ✓ 闸门: 飞线断点检出')


def test_gate_detects_closure():
    """闸门应抓住未闭合轮廓"""
    pts = [[0, 0, 0], [10, 0, 0], [20, 0, 0], [10, 10, 0], [0, 10, 0]]
    try:
        step_verify.assert_outline_ok(pts, 'test', need_closed=True)
        raise AssertionError('应抛出未闭合错误')
    except ValueError as e:
        assert '闭合' in str(e), str(e)
    print('  ✓ 闸门: 未闭合检出')


def test_strip_doubled_paths():
    """重复描边 (出去又沿原路折回) 应被清理, 不残留大跳变"""
    main = [[float(i) * 2, 0, 0] for i in range(10)]          # 0..18 间距2
    retrace = [[float(i) * 2, 0, 0] for i in reversed(range(1, 9))]  # 折返 16..2
    pts = main + retrace + [[18.0, 0, 0], [20.0, 0, 0]]
    out = st.strip_doubled_paths(np.array(pts, dtype=float), tol_mm=2.0)
    d = np.linalg.norm(np.diff(out, axis=0), axis=1)
    assert float(d.max()) < 10, f'清理后仍有大跳变: {d.max():.1f}mm'
    assert len(out) > 5, '清理过度'
    print(f'  ✓ 重复描边清理: {len(pts)}点 → {len(out)}点')


def test_mirror_half_outline():
    """半模闭环 → 剔除接缝 → 镜像 → 完整对称轮廓 (Y=宽度, Z=高度)"""
    # 左半窗口密采样: 底中心→底边→左侧→顶边→顶中心→(Y≈0 接缝)回底中心
    pts = []
    for i in range(15):
        pts.append([0.0, -572.0 * i / 14, 0.0])                            # 底边 0→-572
    for i in range(1, 8):
        pts.append([0.0, -572.0, 241.0 * i / 7])                           # 左侧 0→241
    for i in range(14):
        pts.append([0.0, -572.0 + 572.0 * i / 13, 241.0])                  # 顶边 -572→0
    for i in range(1, 8):
        pts.append([0.0, 0.0, 241.0 - 241.0 * i / 7])                      # 接缝 顶→底
    pts.append([0.0, 0.0, 0.0])                                           # 闭合
    half = np.array(pts, dtype=float)
    full = rw.mirror_half_outline(half)
    ys = full[:, 1]
    assert float(ys.min()) < -550 and float(ys.max()) > 550, f'半模镜像未展开: Y {ys.min():.0f}~{ys.max():.0f}'
    step_verify.assert_outline_ok(full, '半模镜像', need_closed=True)  # 闸门: 连续+闭合
    print(f'  ✓ 半模镜像: Y {ys.min():.0f}~{ys.max():.0f} (跨{ys.max()-ys.min():.0f}), 闸门通过')


def test_integration_mirror_demo():
    """真实文件: acme-auto 内镜提取必须过闸门 (文件缺失跳过)"""
    f = TMP / 'demo-vehicle-INNER-MIRROR-sample.stp'
    if not f.exists():
        print('  - 跳过 (无 acme-auto STEP)')
        return
    r = subprocess.run([sys.executable, str(PY / 'step_topology.py'), str(f)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    out_json = f.with_suffix('.mirror-outline.json')
    assert out_json.exists(), f'提取失败: {r.stdout[-600:]}'
    d = json.loads(out_json.read_text(encoding='utf-8'))
    pts = d['outline_local_mm']
    step_verify.assert_outline_ok(pts, 'acme-auto 镜面')
    print(f'  ✓ acme-auto 镜面: {len(pts)} 点, 闸门通过')


def test_integration_rear_window():
    """真实文件: 后挡风自动识别 + 半模镜像 + 闸门 (文件缺失跳过)"""
    f = TMP / '3D_Shape06574232a.1In_Work.stp'
    if not f.exists():
        print('  - 跳过 (无后挡风 STEP)')
        return
    out = TMP / 'rw-regression.json'
    r = subprocess.run([sys.executable, str(PY / 'step_rear_window.py'), str(f), '--n', '30', '--output', str(out)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    assert out.exists(), f'提取失败: {r.stdout[-600:]}'
    d = json.loads(out.read_text(encoding='utf-8'))
    pts = d['outline_mm']
    step_verify.assert_outline_ok(pts, '后挡风')
    ys = [p[1] for p in pts]
    assert min(ys) < -500 and max(ys) > 500, f'半模镜像未展开: Y {min(ys):.0f}~{max(ys):.0f}'
    print(f'  ✓ 后挡风: {len(pts)} 点, Y跨{max(ys)-min(ys):.0f}, 闸门通过')


if __name__ == '__main__':
    print('=== STEP 提取回归测试 ===')
    tests = [test_gate_detects_breaks, test_gate_detects_closure,
             test_strip_doubled_paths, test_mirror_half_outline,
             test_integration_mirror_demo, test_integration_rear_window]
    failed = 0
    for t in tests:
        name = t.__name__
        try:
            t()
        except Exception as e:
            failed += 1
            print(f'  ✗ {name}: {e}')
    print(f'\n{"❌ 有失败" if failed else "✅ 全部通过"} ({len(tests) - failed}/{len(tests)})')
    sys.exit(1 if failed else 0)
