"""Adds sound-effect cues to the animated scenes of a storyboard, timed to the
same narration events that drive the animations (see animations.Timing).

    python sfx_cues.py <storyboard.json> <timeline.json> [map.json]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from animations import Timing  # noqa: E402


def cues(anim, tm):
    c = lambda sound, at, vol=0.5, **kw: dict(sound=sound, at=round(max(0.0, at), 3), volume=vol, **kw)  # noqa: E731
    if anim == 5:
        out = []
        for k in range(3):
            a, b = tm.seg(k)
            out += [c('pop', a - 0.1, 0.45), c('click', b - 0.12, 0.5)]
        return out + [c('swish', tm.seg(2)[1] - 0.25, 0.3)]
    if anim == 7:
        t = tm.at('congestionamento', 0.5)
        return [c('riser', t - 1.6, 0.3), c('impact', t + 0.05, 0.55)]
    if anim == 8:
        return [c('car_pass', 0.0, 0.3), c('brake', tm.at(['reduz', 'freia'], 0.6), 0.3)]
    if anim == 9:
        return [c('pop', tm.at('percebe', 0.25), 0.4), c('clock', tm.at('reagir', 0.7) - 0.7, 0.35, duration=1.5)]
    if anim == 10:
        return [c('pop', tm.at('distância'), 0.4), c('pop', tm.at('tempo de reação'), 0.4), c('brake', tm.at('frear') - 0.2, 0.3)]
    if anim == 11:
        t0 = tm.s0 + 0.2
        return [c('click', t0 + k * (tm.s1 - t0) / 4, 0.45) for k in range(4)]
    if anim == 12:
        return [c('whoosh', 0.0, 0.3), c('brake', tm.at('onda', 0.5), 0.25)]
    if anim == 13:
        return [c('swish', 0.0, 0.3), c('whoosh', min(3.3, tm.dur * 0.5) - 0.2, 0.3)]
    if anim == 14:
        return [c('pop', 0.3, 0.4), c('ding', tm.at(['veículos', 'carros'], 0.4), 0.3)]
    if anim == 15:
        return [c('brake', tm.dur * 0.45, 0.25), c('pop', tm.dur * 0.6, 0.35)]
    if anim == 17:
        out = [c('ding', tm.at(w, d) - 0.15, 0.3) for w, d in ((['distância'], 0.05), (['acelera', 'brusca'], 0.3),
                                                               (['dirigir', 'dirija', 'constante'], 0.55))]
        return out + [c('whoosh', tm.at(['ajuda', 'reduz'], 0.85) - 0.3, 0.3)]
    if anim == 18:
        return [c('pop', 0.2, 0.35), c('ding', tm.dur * 0.5, 0.3)]
    if anim == 20:
        return [c('brake', 0.6, 0.3), c('impact', tm.at(['parar', 'para '], 0.8), 0.5)]
    if anim == 23:
        return [c('impact', 0.05, 0.5), c('ding', 0.45, 0.35)]
    if anim == 24:
        click = tm.at(['inscreva', 'siga'], 0.4) + 0.9
        return [c('click', click, 0.6), c('ding', click + 0.25, 0.35)]
    return []


def main():
    sb_path, tl_path = sys.argv[1], sys.argv[2]
    mapping = {int(k): v for k, v in json.load(open(sys.argv[3])).items()} if len(sys.argv) > 3 else {}
    sb = json.load(open(sb_path))
    tl = json.load(open(tl_path))
    project = os.path.dirname(os.path.abspath(tl_path))
    for scene, sc in zip(tl['scenes'], sb['scenes']):
        num = scene['scene']
        anim = mapping.get(num, num) if mapping else num
        path = sc['visual'].get('path', '')
        if '/anim/' not in path:
            continue  # image scenes keep their hand-placed effects
        sc['sfx'] = cues(anim, Timing(scene, project))
    json.dump(sb, open(sb_path, 'w'), ensure_ascii=False, indent=2)
    print(f'efeitos: {sum(len(s.get("sfx", [])) for s in sb["scenes"])} em {len(sb["scenes"])} cenas')


if __name__ == '__main__':
    main()
