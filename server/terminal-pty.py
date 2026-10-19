# A login shell on a pseudo terminal for the card's terminal (server/terminal.mjs), without a native Node module.
# argv: shell cwd cols rows. stdin → the terminal, the terminal → stdout, fd 3 takes "resize <cols> <rows>" lines.
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', max(1, rows), max(1, cols), 0, 0))


def write_all(fd, data):
    while data:
        try:
            data = data[os.write(fd, data):]
        except OSError as e:
            if e.errno != errno.EINTR:
                raise


def main():
    shell, cwd, cols, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    pid, master = pty.fork()
    if pid == 0:
        set_size(0, cols, rows)
        try:
            os.chdir(cwd)
        except OSError:
            os.chdir(os.path.expanduser('~'))
        os.execvp(shell, [shell, '-l'])
    ctl = 3
    readers = [master, 0, ctl]
    pending = b''
    while True:
        try:
            ready, _, _ = select.select(readers, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if data:
                write_all(master, data)
            else:
                readers.remove(0)
                os.kill(pid, signal.SIGHUP)
        if ctl in ready:
            data = os.read(ctl, 4096)
            if not data:
                readers.remove(ctl)
                continue
            pending += data
            *lines, pending = pending.split(b'\n')
            for line in lines:
                parts = line.split()
                if len(parts) == 3 and parts[0] == b'resize':
                    set_size(master, int(parts[1]), int(parts[2]))
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) & 0xff)


if __name__ == '__main__':
    main()
