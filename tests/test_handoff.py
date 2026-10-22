"""Handoff math for CordonInjectNoise: strength 0 must continue pass-1 noise exactly.

Simulates the real CONST flow pair (ModelSamplingAuraFlow / MOSSImage):

  sampler internal state at handoff: x_h = h*n1 + (1-h)*x0
  pass-1 `output` P = inverse_noise_scaling(h, x_h) = x_h / (1-h)
      (KSAMPLER.sample always applies inverse_noise_scaling to sigmas[-1])
  pass-2 start with DisableNoise (noise=0): S = noise_scaling(h, 0, L) = (1-h)*L

Exact continuation needs S == x_h, so L == P (passthrough). The old code fed
L = P/(1-h), which starts pass 2 at P = x_h/(1-h) -- 1/(1-h) too large.
"""

import importlib.util
import os
import sys
import types

import torch

PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/home/ac/comfy/ComfyUI")

import comfy.sample  # noqa: F401  (prepare_noise; CPU-only, no model needed)

pkg = types.ModuleType("cordoncanvas_handoff_test")
pkg.__path__ = [PACK]
sys.modules["cordoncanvas_handoff_test"] = pkg
spec = importlib.util.spec_from_file_location(
    "cordoncanvas_handoff_test.cordoncanvas", os.path.join(PACK, "__init__.py"))
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)
CordonInjectNoise = mod.CordonInjectNoise


class FakeMS:
    """CONST flow scaling with noise_scale 1.0."""

    noise_scale = 1.0

    @staticmethod
    def _s(sigma, ndim):
        if sigma.nelement() == 1:
            return sigma.view(())
        return sigma.view(sigma.shape[:1] + (1,) * (ndim - 1))

    def noise_scaling(self, sigma, noise, latent_image, max_denoise=False):
        s = self._s(sigma, noise.ndim)
        return s * noise + (1.0 - s) * latent_image

    def inverse_noise_scaling(self, sigma, latent):
        s = self._s(sigma, latent.ndim)
        return latent / (1.0 - s)


class FakeModel:
    def get_model_object(self, name):
        assert name == "model_sampling", name
        return FakeMS()


H = 0.5


def _pass1(h=H):
    """Return (x_h, P) where x_h is sampler state and P is SamplerCustomAdvanced output."""
    torch.manual_seed(7)
    x0 = torch.randn(1, 8, 16, 16)
    n1 = torch.randn(1, 8, 16, 16)
    x_h = h * n1 + (1 - h) * x0
    p = x_h / (1 - h)
    return x_h, p


def _run(strength, seed, h=H):
    x_h, p = _pass1(h)
    latent = {"samples": p}
    sigmas = torch.tensor([h, 0.2, 0.0])
    out = CordonInjectNoise.execute(latent, FakeModel(), sigmas, strength, seed)
    L = out[0]["samples"]
    S = (1 - h) * L  # simulated pass-2 DisableNoise start
    return x_h, p, S


def test_exact_continuation():
    x_h, p, S = _run(0.0, 123)
    assert torch.allclose(S, x_h, atol=1e-5), (S - x_h).abs().max()


def test_strength_topup():
    x_h, p, S = _run(0.5, 123)
    n2 = comfy.sample.prepare_noise(p, 123).to(dtype=S.dtype)
    assert torch.allclose(S, x_h + 0.5 * n2, atol=1e-5), (S - x_h - 0.5 * n2).abs().max()


def test_degenerate_sigmas_passthrough():
    _, p = _pass1()
    latent = {"samples": p}
    out = CordonInjectNoise.execute(latent, FakeModel(), torch.tensor([0.0]), 0.5, 1)
    assert torch.equal(out[0]["samples"], p)


if __name__ == "__main__":
    test_exact_continuation()
    test_strength_topup()
    test_degenerate_sigmas_passthrough()
    print("ok")
