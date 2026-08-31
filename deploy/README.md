# Deploying to the Pi

## Console blanking

Three separate layers can blank the display: the kernel console, the Wayland
compositor, and the panel's own DPMS. Silence the first in
`/boot/firmware/cmdline.txt` by appending to the existing single line:

```
consoleblank=0
```

## Autostart

Copy `labwc-autostart` to `~/.config/labwc/autostart` (create the directory if
needed). System-wide equivalent is `/etc/xdg/labwc/autostart`.

## Service

```bash
sudo cp home-manager.service /etc/systemd/system/
sudo systemctl enable --now home-manager
journalctl -u home-manager -f
```

## microSD longevity

A 24/7 appliance writing logs to microSD is the expected long-term failure
mode. In `/etc/fstab`:

```
tmpfs /var/log tmpfs defaults,noatime,nosuid,size=64m 0 0
```

And disable swap:

```bash
sudo dphys-swapfile swapoff && sudo systemctl disable dphys-swapfile
```

## Verification checklist

Phase 1 is done when all of these pass:

- [ ] Cold boot to rendered page in under 60 seconds
- [ ] Screen does not blank during the day
- [ ] Pull the power, plug it back in, display returns unattended
- [ ] `systemctl stop home-manager` — page shows a reconnect state, not a crash
- [ ] Disconnect WiFi for 10 minutes — cached schedule still on screen
- [ ] Touch input registers in the correct location after any rotation
