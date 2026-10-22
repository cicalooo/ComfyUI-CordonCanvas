import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from latent import snap, target_size


def test_snap():
    assert snap(1331, 16) == 1328
    assert snap(8, 16) == 16


def test_scale_1024():
    # 1024 canvas → 64x64 latent. 1.5x → 1536, which is 96 latent pixels.
    assert target_size(64, 64, 1.5, 0, 0, 16) == (1536, 1536, 96, 96)


def test_pixel_override_ignores_scale():
    assert target_size(64, 64, 1.5, 1280, 1280, 16) == (1280, 1280, 80, 80)


def test_one_axis():
    assert target_size(64, 64, 1.5, 1280, 0, 16) == (1280, 1280, 80, 80)


if __name__ == "__main__":
    test_snap()
    test_scale_1024()
    test_pixel_override_ignores_scale()
    test_one_axis()
    print("ok")
