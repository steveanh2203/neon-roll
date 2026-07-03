# Neon Roll 3D

Endless roller 3D phong cách neon synthwave cho web (CrazyGames), xây bằng Three.js + TypeScript + Vite.

Bóng tự lao xuống dốc với tốc độ tăng dần — lái trái/phải để né khối đỏ, bay qua hố, và lao qua **cổng tím để đảo trọng lực** xuống lăn ở mặt dưới track.

## Chạy dev

```bash
npm install
npm run dev
```

Mặc định Vite mở tại `http://localhost:5173` (dev qua launch config dùng port 5177).

## Điều khiển

- **A / D** hoặc **← / →**: lái trái/phải
- **P / Esc**: pause
- Mobile: chạm nửa trái / phải màn hình

## Kiểm tra & build

```bash
npm run typecheck
npm run build   # output vào dist/, ~131KB gzip
```

## Cấu trúc

- `src/main.ts` — toàn bộ game: physics, track sinh procedural (đường tâm bằng hàm sin — physics và render dùng chung), cơ chế đảo trọng lực, camera, UI, audio WebAudio
- `src/style.css` — UI neon: HUD, menu, pause, game over
- Debug hook: `window.__nr` (state, tick thủ công từng frame cho automated test)

## Trạng thái / TODO trước khi submit CrazyGames

- [x] Core loop: lăn, né, hố, chết, retry, best score
- [x] Twist đảo trọng lực (cổng tím, chướng ngại 2 mặt track)
- [x] UI đầy đủ: HUD, pause, stats, toast, sound toggle
- [ ] Juice: hiệu ứng bóng vỡ khi crash, particle khi qua cổng, gem nhặt
- [ ] CrazyGames SDK: gameplayStart/Stop + rewarded ad "REVIVE" (đã đánh dấu chỗ gắn trong `die()`)
- [ ] Thumbnail + submit developer portal
