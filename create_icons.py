
from PIL import Image, ImageDraw, ImageFont

def create_icon(size, filename):
    img = Image.new("RGB", (size, size), "#0f172a")
    draw = ImageDraw.Draw(img)

    # Hotel building
    margin = size * 0.25
    left = margin
    top = size * 0.20
    right = size - margin
    bottom = size * 0.76

    draw.rounded_rectangle(
        (left, top, right, bottom),
        radius=int(size * 0.035),
        fill="#ffffff"
    )

    # Windows
    window_size = int(size * 0.075)
    gap = int(size * 0.09)

    for row in range(3):
        for col in range(3):
            x = int(size * 0.34) + col * gap
            y = int(size * 0.28) + row * gap

            draw.rectangle(
                (x, y, x + window_size, y + window_size),
                fill="#0f172a"
            )

    # Entrance
    draw.rectangle(
        (
            int(size * 0.45),
            int(size * 0.62),
            int(size * 0.55),
            int(size * 0.76)
        ),
        fill="#0f172a"
    )

    # Brand text
    try:
        font = ImageFont.truetype("arial.ttf", int(size * 0.075))
    except OSError:
        font = ImageFont.load_default()

    text = "STAYCRAFT"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]

    draw.text(
        ((size - text_width) / 2, size * 0.82),
        text,
        fill="#ffffff",
        font=font
    )

    img.save(filename)

create_icon(192, "public/pwa-192x192.png")
create_icon(512, "public/pwa-512x512.png")

print("StayCraft PWA icons created successfully!")
