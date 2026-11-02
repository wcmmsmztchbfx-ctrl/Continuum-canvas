# generation 操作

先 read_nodes 读取所有目标、容器、相关父级和连线端点。使用下面的实时注册表契约，不推测字段。
调用 run_canvas_command 时提供 command、parameters、expectedRevision；可先 dryRun:true。正式提交后按回执影响集回读。
