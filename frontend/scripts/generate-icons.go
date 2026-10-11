package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"os"
	"path/filepath"
)

const supersampling = 4

func main() {
	for _, size := range []int{180, 192, 512} {
		if err := writeIcon(size); err != nil {
			log.Fatal(err)
		}
	}
}

func writeIcon(size int) error {
	canvasSize := size * supersampling
	canvas := image.NewRGBA(image.Rect(0, 0, canvasSize, canvasSize))
	fill(canvas, color.RGBA{R: 0x18, G: 0x18, B: 0x1b, A: 0xff})

	gold := color.RGBA{R: 0xd4, G: 0xd4, B: 0xd8, A: 0xff}
	barWidth := canvasSize * 11 / 100
	gap := canvasSize * 7 / 100
	totalWidth := barWidth*3 + gap*2
	left := (canvasSize - totalWidth) / 2
	baseline := canvasSize * 69 / 100
	heights := []int{canvasSize * 22 / 100, canvasSize * 42 / 100, canvasSize * 30 / 100}
	radius := canvasSize * 2 / 100
	for index, height := range heights {
		drawRoundedRect(canvas, left+index*(barWidth+gap), baseline-height, barWidth, height, radius, gold)
	}

	icon := downsample(canvas, size)
	path := filepath.Join("public", "icons", "tmux-"+itoa(size)+".png")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return png.Encode(file, icon)
}

func fill(target *image.RGBA, shade color.RGBA) {
	for y := target.Rect.Min.Y; y < target.Rect.Max.Y; y++ {
		for x := target.Rect.Min.X; x < target.Rect.Max.X; x++ {
			target.SetRGBA(x, y, shade)
		}
	}
}

func drawRoundedRect(target *image.RGBA, x, y, width, height, radius int, shade color.RGBA) {
	for py := y; py < y+height; py++ {
		for px := x; px < x+width; px++ {
			dx := max(max(x+radius-px, 0), px-(x+width-radius-1))
			dy := max(max(y+radius-py, 0), py-(y+height-radius-1))
			if dx*dx+dy*dy <= radius*radius {
				target.SetRGBA(px, py, shade)
			}
		}
	}
}

func downsample(source *image.RGBA, size int) *image.RGBA {
	target := image.NewRGBA(image.Rect(0, 0, size, size))
	area := uint32(supersampling * supersampling)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var red, green, blue uint32
			for sy := 0; sy < supersampling; sy++ {
				for sx := 0; sx < supersampling; sx++ {
					shade := source.RGBAAt(x*supersampling+sx, y*supersampling+sy)
					red += uint32(shade.R)
					green += uint32(shade.G)
					blue += uint32(shade.B)
				}
			}
			target.SetRGBA(x, y, color.RGBA{R: uint8(red / area), G: uint8(green / area), B: uint8(blue / area), A: 0xff})
		}
	}
	return target
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	position := len(digits)
	for value > 0 {
		position--
		digits[position] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[position:])
}
