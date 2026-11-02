# 排版

read_nodes → read_skill(canvas-base, commands/geometry.md) → describe_canvas_command(geometry.layout/align/distribute) → dryRun → 正式执行 → read_nodes 核对位置与父级。网格固定 48px；对齐和等距按未旋转世界坐标包围盒；不要同时操作祖先与后代。
