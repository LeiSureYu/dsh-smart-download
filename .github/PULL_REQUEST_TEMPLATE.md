## 改了什么

<!-- 一两句话。如果修的是 bug，写清现象。 -->

## 为什么

<!-- 根因，或者这个改动的动机。 -->

## 实测证据

<!-- 项目要求：回退/跳过/默认值路径必须有正向断言；性能数字必须有前后对比。 -->

- 新增/修改的用例：
- 实测命令与输出：

```
```

## 检查清单

- [ ] `pnpm check` 通过（src/ 与 test/ 两个 tsconfig）
- [ ] `pnpm test` 全绿，没有靠改断言把失败按下去
- [ ] 新增的回退/跳过路径有**正向断言**（断言回落到的具体值，不是「没抛异常」）
- [ ] 覆盖率数字来自 `node --test --experimental-test-coverage`，不是手搓 `NODE_V8_COVERAGE`
- [ ] 改了公开行为的话，README（中英双语）、CHANGELOG 与相关 docs 已同步
- [ ] 没有提交临时脚本、`coverage.lcov`、lockfile 或二进制

## 关联

<!-- Closes #123 / 相关 issue -->