"""Send lighting feature reports to an ENEK5130 keyboard: enek-write.py /dev/hidrawN HEX [HEX...].

Node has no ioctl(), so lighting.js runs this for each update. Errors go to stderr as "ECODE: message".
"""
import errno
import fcntl
import os
import sys
import time


def hidiocsfeature(length):
    return (3 << 30) | (length << 16) | (ord("H") << 8) | 0x06


def main():
    device, *reports = sys.argv[1:]
    try:
        fd = os.open(device, os.O_RDWR | os.O_NONBLOCK)
        try:
            for i, report in enumerate(reports):
                if i:
                    time.sleep(0.02)  # Acer waits 20 ms between zone reports
                buf = bytearray.fromhex(report)
                fcntl.ioctl(fd, hidiocsfeature(len(buf)), buf, True)
        finally:
            os.close(fd)
    except OSError as error:
        sys.exit(f"{errno.errorcode.get(error.errno, 'EIO')}: {error.strerror}")


if __name__ == "__main__":
    main()
