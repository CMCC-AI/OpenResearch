# Optional release highlights

MobileSci 源码版本使用 `release-notes/v<产品版本>.md`。流程与交付范围见 [版本发布](../docs/product/releases.md)；其发布分支必须先通过完整 CI，再创建标签与 GitHub Release。

To add a custom note to a release, commit `release-notes/vX.Y.Z.md` in the PR that bumps `Cargo.toml` to `X.Y.Z`. Write the Markdown exactly as it should appear above the generated changes, for example:

```md
## Highlights

The Linux desktop app now updates itself.
```

Leave the file out when there is nothing to add. The release workflow generates the PR list, linked fixed issues, comparison link, and install instructions automatically.
