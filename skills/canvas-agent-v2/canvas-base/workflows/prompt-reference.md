# 提示词与引用

read_nodes → references.attach → 从实际 referenceAlias 获取 @1 等身份 → generation.prompt → generation.settings（如需）→ 回读提示词、引用边和配置。更新提示词或配置不会生成。确需生成再读取 image-generation/video-generation 与 generation_config，调用现有 request_generation。
