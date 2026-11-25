"""Traffic micro-simulation used by the animations (Intelligent Driver Model).

IDM: Treiber, Hennecke & Helbing (2000), Phys. Rev. E 62, 1805.
    dv/dt = a [1 - (v/v0)^4 - (s*/s)^2],  s* = s0 + vT + v dv / (2 sqrt(ab))

Scenarios:
  ring()      22 cars on a 230 m circular track, as in Sugiyama et al. (2008),
              New J. Phys. 10, 033001 — a jam forms with no bottleneck.
  platoon()   a column of cars on an open road; the leader slows slightly and
              the disturbance grows as it travels backwards (accordion effect).
  ring(smart=...) one vehicle switches to a smooth constant-speed controller,
              in the spirit of Stern et al. (2018), Transp. Res. C 89, 205.
"""
from dataclasses import dataclass
import numpy as np


@dataclass
class IDM:
    v0: float = 15.0   # desired speed (m/s)
    T: float = 0.55    # time headway (s)
    s0: float = 1.0    # jam distance (m)
    a: float = 0.5     # max acceleration (m/s2)
    b: float = 2.0     # comfortable deceleration (m/s2)
    length: float = 4.5

    def acc(self, v, gap, dv):
        s_star = self.s0 + np.maximum(0.0, v * self.T + v * dv / (2 * np.sqrt(self.a * self.b)))
        return self.a * (1 - (v / self.v0) ** 4 - (s_star / np.maximum(gap, 0.05)) ** 2)


def ring(n=22, L=230.0, seconds=180.0, dt=0.05, p=IDM(), noise=0.0, kick=(0, 1.0, 2.0),
         smart=None, seed=1, x0=None, v0=None):
    """Return times t[k], positions x[k, i] (unwrapped, m), speeds v[k, i] (m/s).

    kick = (car, t_start, duration): that car brakes gently once (the trigger).
    smart = (car, t_on, speed): from t_on that car drives smoothly at `speed`
            (never closer than IDM safety allows) and so absorbs the waves.
    """
    rng = np.random.default_rng(seed)
    steps = int(round(seconds / dt))
    x = np.arange(n) * (L / n) if x0 is None else x0.copy()
    v = np.full(n, 8.0) if v0 is None else v0.copy()
    T = np.zeros(steps + 1)
    X = np.zeros((steps + 1, n))
    V = np.zeros((steps + 1, n))
    X[0], V[0] = x, v
    for k in range(steps):
        t = k * dt
        lead = np.roll(np.arange(n), -1)
        gap = (x[lead] - x) % L - p.length
        gap[gap < 0] += L
        dv = v - v[lead]
        acc = p.acc(v, gap, dv)
        if noise:
            acc += rng.normal(0, noise, n)
        if kick and kick[1] <= t < kick[1] + kick[2]:
            acc[kick[0]] = min(acc[kick[0]], -1.2)
        if smart and t >= smart[1]:
            i = smart[0]
            calm = float(np.clip(0.4 * (smart[2] - v[i]), -0.8, 0.5))
            acc[i] = min(calm, p.acc(v[i], gap[i], dv[i]))  # smooth, but never unsafe
        v_new = np.maximum(0.0, v + acc * dt)
        x = x + np.maximum(0.0, v * dt + 0.5 * acc * dt * dt)
        v = v_new
        T[k + 1], X[k + 1], V[k + 1] = t + dt, x, v
    return T, X, V


def platoon(n=40, seconds=60.0, dt=0.05, p=IDM(v0=30.0, T=1.3, s0=2.0, a=0.6, b=2.0),
            cruise=25.0, dip=21.0, t_brake=3.0, brake_len=2.5, reaction=0.0):
    """Open road column. Car 0 is the leader (rightmost). Positions in metres.

    reaction: human perception delay (s). Each follower reacts to what it saw
    `reaction` seconds ago (as in the Human Driver Model, Treiber et al. 2006),
    which is what lets a small slowdown grow into a stop-and-go wave."""
    s_eq = (p.s0 + cruise * p.T) / np.sqrt(max(1e-6, 1 - (cruise / p.v0) ** 4))
    headway = s_eq + p.length
    x = -np.arange(n) * headway
    v = np.full(n, cruise)
    steps = int(round(seconds / dt))
    T = np.zeros(steps + 1)
    X = np.zeros((steps + 1, n))
    V = np.zeros((steps + 1, n))
    X[0], V[0] = x, v
    for k in range(steps):
        t = k * dt
        gap = np.empty(n)
        dv = np.empty(n)
        d = int(round(reaction / dt))
        xs, vs = (X[k - d], V[k - d]) if d and k >= d else (x, v)
        gap[1:] = xs[:-1] - xs[1:] - p.length
        dv[1:] = vs[1:] - vs[:-1]
        gap[0], dv[0] = 1e9, 0.0
        acc = p.acc(vs if d and k >= d else v, gap, dv)
        # leader: gentle dip then back to cruise
        if t_brake <= t < t_brake + brake_len:
            target = dip
        else:
            target = cruise
        acc[0] = np.clip(0.8 * (target - v[0]), -1.5, 1.0)
        v_new = np.maximum(0.0, v + acc * dt)
        x = x + np.maximum(0.0, v * dt + 0.5 * acc * dt * dt)
        v = v_new
        T[k + 1], X[k + 1], V[k + 1] = t + dt, x, v
    return T, X, V


def min_gap(X, L, length):
    n = X.shape[1]
    lead = np.roll(np.arange(n), -1)
    g = (X[:, lead] - X) % L - length
    return float(g.min())


def ring_mixed(n=22, L=230.0, seconds=120.0, dt=0.05, p=IDM(a=0.5), p_smart=None, smart_car=0,
               kick=(5, 1.0, 2.0)):
    """Ring where `smart_car` drives with its own, calmer parameters (p_smart):
    a long time gap and gentle acceleration, like a vehicle with adaptive cruise
    control tuned to absorb waves. With p_smart=None every car is human."""
    steps = int(round(seconds / dt))
    x = np.arange(n) * (L / n)
    v = np.full(n, 8.0)
    T = np.zeros(steps + 1)
    X = np.zeros((steps + 1, n))
    V = np.zeros((steps + 1, n))
    X[0], V[0] = x, v
    for k in range(steps):
        t = k * dt
        lead = np.roll(np.arange(n), -1)
        gap = (x[lead] - x) % L - p.length
        dv = v - v[lead]
        acc = p.acc(v, gap, dv)
        if kick and kick[1] <= t < kick[1] + kick[2]:
            acc[kick[0]] = min(acc[kick[0]], -1.2)
        if p_smart is not None:
            i = smart_car
            acc[i] = p_smart.acc(v[i], gap[i], dv[i])
        v_new = np.maximum(0.0, v + acc * dt)
        x = x + np.maximum(0.0, v * dt + 0.5 * acc * dt * dt)
        v = v_new
        T[k + 1], X[k + 1], V[k + 1] = t + dt, x, v
    return T, X, V


# Parameter sets used in the episode (chosen numerically, see README).
HUMAN_RING = IDM(v0=15.0, T=0.55, s0=1.0, a=0.5, b=2.0)
SMART = IDM(v0=8.5, T=2.2, s0=3.0, a=0.25, b=1.0)
HIGHWAY = IDM(v0=33.0, T=1.2, s0=2.0, a=1.2, b=2.0)
