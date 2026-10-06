# Postfold icon

The folded **P** is a monochrome mark designed to remain readable at favicon size. [The SVG source](../public/icon.svg) is used by the application and README; the ICO and PNG files are generated from it.

To regenerate the raster assets with `rsvg-convert` and ImageMagick:

```sh
rsvg-convert -w 512 -h 512 public/icon.svg -o public/icon-512.png
magick public/icon-512.png -resize 192x192 public/icon-192.png
magick public/icon-512.png -background '#18181b' -alpha remove -alpha off -resize 180x180 public/apple-touch-icon.png
magick public/icon-512.png -resize 32x32 public/favicon-32.png
magick public/icon-512.png -define icon:auto-resize=64,48,32,16 public/favicon.ico
```

`site.webmanifest` supplies the application name, theme color and launcher icons. It does not add offline support or a service worker. Brand assets use the repository's AGPL-3.0-only license.
