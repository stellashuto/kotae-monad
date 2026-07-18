from pathlib import Path
import wave
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "demo-frames"
OUT.mkdir(parents=True, exist_ok=True)

W, H = 1280, 720
INK = "#10120f"
PAPER = "#f2f0e7"
ACID = "#b7ff17"
PURPLE = "#8c71ff"
MUTED = "#777a70"
DARK = "#141711"
WHITE = "#f4f3eb"

FONT_DIR = Path("C:/Windows/Fonts")


def font(size, bold=False, mono=False):
    name = "consolab.ttf" if mono and bold else "consola.ttf" if mono else "arialbd.ttf" if bold else "arial.ttf"
    return ImageFont.truetype(str(FONT_DIR / name), size)


def text(draw, xy, value, size, fill=INK, bold=False, anchor="la", mono=False):
    draw.text(xy, value, font=font(size, bold=bold, mono=mono), fill=fill, anchor=anchor)


def wrapped(draw, xy, value, size, width, fill=MUTED, bold=False, spacing=10):
    words = value.split()
    lines, line = [], ""
    face = font(size, bold=bold)
    for word in words:
        candidate = f"{line} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=face)[2] > width and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    draw.multiline_text(xy, "\n".join(lines), font=face, fill=fill, spacing=spacing)


def base(kicker, index, total=7):
    image = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(image)
    draw.ellipse((48, 26, 92, 70), outline=INK, width=2)
    draw.ellipse((77, 25, 91, 39), fill=ACID, outline=INK, width=2)
    text(draw, (102, 57), "KOTAE", 22, bold=True)
    text(draw, (1220, 54), kicker, 13, fill=MUTED, bold=True, anchor="ra", mono=True)
    draw.rectangle((50, 684, 1230, 688), fill="#d7d5cc")
    draw.rectangle((50, 684, 50 + int(1180 * ((index + 1) / total)), 688), fill=ACID)
    return image, draw


def card(draw, x, y, top, title, detail, accent):
    draw.rectangle((x, y, x + 350, y + 150), fill=DARK)
    text(draw, (x + 22, y + 34), top, 13, fill=accent, bold=True, mono=True)
    text(draw, (x + 22, y + 82), title, 24, fill=WHITE, bold=True)
    text(draw, (x + 22, y + 120), detail, 13, fill="#a9aca2", mono=True)


def save(image, number):
    path = OUT / f"frame-{number:02d}.png"
    image.save(path, optimize=True)
    return path


frames = []

image, draw = base("KOTAE / MONAD TESTNET", 0)
text(draw, (62, 230), "BUY THE ANSWER.", 68, bold=True)
text(draw, (62, 310), "NOT THE ATTEMPTS.", 68, bold=True)
wrapped(draw, (66, 414), "A competition marketplace for finished AI-assisted work.", 27, 760)
draw.rectangle((950, 146, 1220, 518), fill=DARK)
text(draw, (1085, 270), "3.00", 58, fill=ACID, bold=True, anchor="mm")
text(draw, (1085, 330), "AUSD LOCKED", 14, fill="#a9aca2", bold=True, anchor="mm", mono=True)
draw.rectangle((980, 406, 1190, 468), fill=ACID)
text(draw, (1085, 438), "FINISHED WORK", 17, bold=True, anchor="mm")
frames.append(save(image, 1))

image, draw = base("TWO SIDES / ONE FUNDED BRIEF", 1)
text(draw, (62, 230), "NEED THE RESULT?", 60, bold=True)
text(draw, (62, 304), "CAN CREATE IT?", 60, fill=PURPLE, bold=True)
wrapped(draw, (66, 400), "KOTAE matches stuck requesters with capable AI creators around one funded brief.", 27, 800)
draw.rectangle((950, 146, 1220, 518), fill=DARK)
text(draw, (1085, 270), "MATCH", 50, fill=ACID, bold=True, anchor="mm")
text(draw, (1085, 330), "FUNDED BRIEF", 14, fill="#a9aca2", bold=True, anchor="mm", mono=True)
draw.rectangle((980, 406, 1190, 468), fill=ACID)
text(draw, (1085, 438), "REAL DEMAND", 17, bold=True, anchor="mm")
frames.append(save(image, 2))

image, draw = base("ONE FUNDED BRIEF / MANY FINISHED OUTCOMES", 2)
text(draw, (62, 196), "REQUESTER FUNDS.", 52, bold=True)
text(draw, (62, 256), "CREATORS DELIVER.", 52, bold=True)
wrapped(draw, (66, 316), "AUSD is locked first. Creators submit completed work with a refundable bond.", 24, 1050)
card(draw, 62, 405, "01", "FUND THE BRIEF", "AUSD LOCKED ONCHAIN", ACID)
card(draw, 465, 405, "02", "SUBMIT OUTCOMES", "PRIVATE FINISHED FILES", PURPLE)
card(draw, 868, 405, "03", "CHOOSE RESULT", "REQUESTER DECISION", ACID)
frames.append(save(image, 3))

image, draw = base("SEPARATED RESPONSIBILITIES", 3)
text(draw, (62, 196), "THE ORACLE CHECKS RULES.", 50, bold=True)
text(draw, (62, 256), "THE REQUESTER CHOOSES.", 50, fill=PURPLE, bold=True)
wrapped(draw, (66, 316), "Objective compliance is recorded onchain. Creative preference stays human.", 24, 1050)
card(draw, 62, 405, "REQUESTER", "WINNER CHOICE", "0x8860...980F", ACID)
card(draw, 465, 405, "CREATOR", "FINISHED WORK", "0x5edc...FA0f", PURPLE)
card(draw, 868, 405, "ORACLE", "OBJECTIVE RULES", "0x04f2...4e87", ACID)
frames.append(save(image, 4))

image, draw = base("LIVE WORKING PROOF", 4)
text(draw, (62, 176), "KOTAE SPARK", 64, bold=True)
text(draw, (62, 246), "LAUNCH VISUAL", 64, bold=True)
wrapped(draw, (66, 308), "3.00 AUSD locked / 1 onchain submission / 1 VALID entry", 24, 750)
text(draw, (66, 392), "REQUESTER", 12, fill=MUTED, bold=True, mono=True)
text(draw, (66, 422), "0x8860a4d3...3943980f", 17, bold=True, mono=True)
text(draw, (420, 392), "ONCHAIN SUBMISSIONS", 12, fill=MUTED, bold=True, mono=True)
text(draw, (420, 422), "1", 17, bold=True, mono=True)
draw.rectangle((900, 136, 1220, 578), fill=DARK)
text(draw, (930, 184), "BASE PRIZE LOCKED", 12, fill="#9da097", mono=True)
text(draw, (930, 210), "3.00", 58, fill=ACID, bold=True, anchor="lt")
text(draw, (930, 292), "AUSD / MONAD TESTNET", 12, fill="#9da097", mono=True)
draw.rectangle((930, 338, 1190, 343), fill="#373a34")
draw.rectangle((930, 338, 956, 343), fill=PURPLE)
text(draw, (930, 374), "1 VALID", 12, fill=WHITE, bold=True, mono=True)
text(draw, (1190, 374), "10 MAX", 12, fill="#9da097", bold=True, anchor="ra", mono=True)
draw.rectangle((930, 414, 1190, 490), fill=ACID)
text(draw, (1060, 462), "REAL LIVE ENTRY", 18, bold=True, anchor="ma")
text(draw, (930, 536), "Oracle tx 0x3ef1...7710", 12, fill="#9da097", mono=True)
frames.append(save(image, 5))

image, draw = base("DETERMINISTIC SETTLEMENT", 5)
text(draw, (62, 196), "85% WINNER / 5% RUNNERS-UP", 48, bold=True)
text(draw, (62, 256), "10% KOTAE", 52, fill=PURPLE, bold=True)
wrapped(draw, (66, 316), "Private originals stay wallet-gated. Every state change is backed by a finalized Testnet receipt.", 24, 1050)
for x, width, value, name, color in [
    (62, 720, "85%", "SELECTED WINNER", ACID),
    (782, 180, "5%", "RUNNERS-UP", PURPLE),
    (962, 258, "10%", "KOTAE", INK),
]:
    draw.rectangle((x, 422, x + width, 556), fill=color)
    fg = WHITE if color == INK else INK
    text(draw, (x + 24, 476), value, 40, fill=fg, bold=True)
    text(draw, (x + 24, 524), name, 12, fill=fg, bold=True, mono=True)
frames.append(save(image, 6))

image, draw = base("LIVE / PUBLIC / OPEN SOURCE", 6)
text(draw, (W // 2, 286), "KOTAE", 122, bold=True, anchor="mm")
text(draw, (W // 2, 398), "BUY THE ANSWER. NOT THE ATTEMPTS.", 25, fill=PURPLE, bold=True, anchor="mm")
text(draw, (W // 2, 458), "kotae-monad-spark.vercel.app", 18, fill=MUTED, bold=True, anchor="mm", mono=True)
text(draw, (W // 2, 490), "github.com/stellashuto/kotae-monad", 16, fill=MUTED, bold=True, anchor="mm", mono=True)
text(draw, (W // 2, 548), "ESCROW  0x7A8806bf...Dac46cC", 14, bold=True, anchor="mm", mono=True)
frames.append(save(image, 7))

with wave.open(str(ROOT / "public" / "kotae-demo-voice.wav"), "rb") as voice:
    total = voice.getnframes() / voice.getframerate()
points = [0.00, 0.16, 0.34, 0.51, 0.68, 0.84, 0.95, 1.00]
concat = []
for index, path in enumerate(frames):
    concat.append(f"file '{path.as_posix()}'")
    concat.append(f"duration {total * (points[index + 1] - points[index]):.6f}")
concat.append(f"file '{frames[-1].as_posix()}'")
(OUT / "concat.txt").write_text("\n".join(concat) + "\n", encoding="utf-8")

print(f"Rendered {len(frames)} frames to {OUT}")
