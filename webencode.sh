#!/bin/bash
# Make lighter web copies of every final (crf 22, max 6 Mbit/s) and posters; serialized under the shared render lock.
cd "$(dirname "$0")"; mkdir -p web posters
for f in ../finals/DM-*.mp4; do b=$(basename "$f"); [ web/$b -nt "$f" ] && continue
  flock ~/.locks/decisionmodels-video-render.lock nice -n 10 ionice -c3 ffmpeg -v error -y -i "$f" -c:v libx264 -preset medium -crf 22 -maxrate 6M -bufsize 12M -pix_fmt yuv420p -c:a copy -movflags +faststart web/$b
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f"); t=$(python3 -c "print(round(float('$d')*0.6,2))")
  ffmpeg -v error -y -ss $t -i "$f" -frames:v 1 -vf "scale='if(gt(iw,ih),1280,720)':-2" -q:v 3 posters/${b%.mp4}.jpg
done; du -sh web
