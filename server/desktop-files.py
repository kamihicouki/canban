"""Exclusive directory rename; never fall back to an overwriting rename."""
import ctypes
import errno
import os
import stat
import sys


def move(source, destination):
    if not all(os.path.isabs(p) and "\0" not in p for p in (source, destination)):
        raise OSError(errno.EINVAL, "absolute paths required")
    current = os.lstat(source)
    if not stat.S_ISDIR(current.st_mode) or current.st_uid != os.getuid():
        raise OSError(errno.EPERM, "owned directory required")
    if current.st_dev != os.stat(os.path.dirname(destination)).st_dev:
        raise OSError(errno.EXDEV, "same filesystem required")
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(os.fsencode(source), os.fsencode(destination), 4)  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1)  # RENAME_NOREPLACE
    else:
        raise OSError(errno.ENOSYS, "exclusive rename unavailable")
    if result:
        raise OSError(ctypes.get_errno(), "exclusive rename failed")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise OSError(errno.EINVAL, "two paths required")
        move(sys.argv[1], sys.argv[2])
    except (OSError, AttributeError) as error:
        # Do not include user paths, profile contents, or credentials in output.
        print(getattr(error, "errno", errno.ENOSYS), file=sys.stderr)
        sys.exit(1)
