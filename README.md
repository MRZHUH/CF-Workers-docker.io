[**第三方 DockerHub 镜像服务列表**](https://github.com/cmliu/CF-Workers-docker.io?tab=readme-ov-file#%EF%B8%8F-%E7%AC%AC%E4%B8%89%E6%96%B9-dockerhub-%E9%95%9C%E5%83%8F%E6%9C%8D%E5%8A%A1)

![CF-Workers-docker.io](./img.png)

# 🐳 CF-Workers-docker.io：Docker仓库镜像代理工具

这个项目是一个基于 Cloudflare Workers 的 Docker 镜像代理工具。它能够中转对 Docker 官方镜像仓库的请求，解决一些访问限制和加速访问的问题。

> [!CAUTION]
> **docker.fxxk.dedyn.io 已被GFW污染，需自行部署使用。**

> [!WARNING]
> 根据 [Cloudflare 协议](https://www.cloudflare.com/zh-cn/terms/) 中，2.2.1 第 (j) use the Services to provide a virtual private network or other similar proxy services.
>
> 使用本服务可能存在被 Cloudflare 封号的潜在风险，请自行斟酌使用风险。
>
> 如果你选择了“根据主机名选择对应的上游地址”方式部署，你可能会:
> 
> 被 Netcraft 扫描到，收到警告邮件
>
> 被 Netcraft 同步到 Google Safe Browsing 标记为钓鱼网站
>
> 被 Netcraft 投诉到 Cloudflare 标记为钓鱼网站, 无法正常 pull 镜像
>
> 收到律师函

## 🚀 部署方式

- **Workers** 部署：复制 [_worker.js](https://github.com/cmliu/CF-Workers-docker.io/blob/main/_worker.js) 代码，`保存并部署`即可
- **Pages** 部署：`Fork` 后 `连接GitHub` 一键部署即可

## ⚙️ 如何使用？ [视频教程](https://www.youtube.com/watch?v=l2jwq9CagNQ)

例如您的Workers项目域名为：`docker.fxxk.dedyn.io`；

### 1.官方镜像路径前面加域名

```shell
docker pull docker.fxxk.dedyn.io/stilleshan/frpc:latest
```

```shell
docker pull docker.fxxk.dedyn.io/library/nginx:stable-alpine3.19-perl
```

### 2.一键设置镜像加速

修改文件 `/etc/docker/daemon.json`（如果不存在则创建）

```shell
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": ["https://docker.fxxk.dedyn.io"]  # 请替换为您自己的Worker自定义域名
}
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker
```

### 3. 配置常见仓库的镜像加速

#### 3.1 配置

`Containerd` 较简单，它支持任意 `registry` 的 `mirror`，只需要修改配置文件 `/etc/containerd/config.toml`，添加如下的配置：

```yaml
    [plugins."io.containerd.grpc.v1.cri".registry]
      [plugins."io.containerd.grpc.v1.cri".registry.mirrors]
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
          endpoint = ["https://xxxx.xx.com"]
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors."registry.k8s.io"]
          endpoint = ["https://xxxx.xx.com"]
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors."k8s.gcr.io"]
          endpoint = ["https://xxxx.xx.com"]
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors."gcr.io"]
          endpoint = ["https://xxxx.xx.com"]
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors."ghcr.io"]
          endpoint = ["https://xxxx.xx.com"]
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors."quay.io"]
          endpoint = ["https://xxxx.xx.com"]
```

`Podman` 同样支持任意 `registry` 的 `mirror`，修改配置文件 `/etc/containers/registries.conf`，添加配置：

```yaml
unqualified-search-registries = ['docker.io', 'k8s.gcr.io', 'gcr.io', 'ghcr.io', 'quay.io']

[[registry]]
prefix = "docker.io"
insecure = true
location = "registry-1.docker.io"

[[registry.mirror]]
location = "xxxx.xx.com"

[[registry]]
prefix = "registry.k8s.io"
insecure = true
location = "registry.k8s.io"

[[registry.mirror]]
location = "xxxx.xx.com"

[[registry]]
prefix = "k8s.gcr.io"
insecure = true
location = "k8s.gcr.io"

[[registry.mirror]]
location = "xxxx.xx.com"

[[registry]]
prefix = "gcr.io"
insecure = true
location = "gcr.io"

[[registry.mirror]]
location = "xxxx.xx.com"

[[registry]]
prefix = "ghcr.io"
insecure = true
location = "ghcr.io"

[[registry.mirror]]
location = "xxxx.xx.com"

[[registry]]
prefix = "quay.io"
insecure = true
location = "quay.io"

[[registry.mirror]]
location = "xxxx.xx.com"

```

#### 3.3 使用

对于以上配置，k8s 在使用的时候，就可以直接 `pull` 外部无法 pull 的镜像了。

```shell
# 手动可以直接pull配置了mirror的仓库
crictl pull registry.k8s.io/kube-proxy:v1.28.4
docker  pull nginx:1.21
```

## 🛡️ 安全运维：预览访问与运行时预算

本项目是只读镜像拉取代理。以下设置是安全边界的一部分，后续部署和故障回退都必须保留：

- **保持 Pages `Restrict previews`（`Enable access policy`）开启。** 项目 `cf-workers-docker-io` 的 Access 域名范围为 `*.cf-workers-docker-io-4gy.pages.dev`，保护 hash 固定部署 URL 和分支预览 URL。旧部署仍运行各自的历史代码；仅更新生产别名不能阻止从历史 URL 绕过上游白名单等修复。使用受限成员策略，不要添加公共 `Bypass` 或为了调试关闭保护。
- 公开拉取入口仍为 `docker.funcd.org` 和 `cf-workers-docker-io-4gy.pages.dev`。发布时先验证固定/预览 URL 对未登录请求返回 Access 登录跳转，再验证两个公开入口的 `/v2/` 返回正常 registry `401` challenge；不要把公开入口纳入要求交互登录的 Access 通配范围。
- **禁止回滚到易受攻击的历史版本。** 保存部署回执用于审计；需要回退时，只选择包含代理安全修复的版本或从已修复源码重新部署。不能将旧开放代理重新指向生产别名，也不能关闭 Access 来使用旧版本。
- **保留项目管理的 CPU 上限：production 和 preview 均为 `limits.cpu_ms = 1000`。** 这是每次调用的 CPU 时间上限，不是下载墙钟时间或总账单上限。设置由 Pages 项目管理；每次部署后核对准确提交的部署回执及生成运行时的 `limits.cpu_ms`，不能仅凭项目配置已保存就认定旧部署已应用新上限。
- Worker 的 300 请求/IP/分钟限制只在单个 isolate 内生效，最多保留 4096 个 IP 记录；它不能保证全局调用或账单硬上限。Docker Hub 返回源站 `429` 时应如实传递，不能增加自动重试或任意上游回退来绕过额度。共享匿名出口额度耗尽时，不能把成功的 blob/HEAD/Range 测试宣称为完整 manifest 拉取通过。
- 保持仓库的 `Upstream Sync` workflow 停用；任何上游同步都必须先审查其是否保留这些代理保护和运维约束。

参考：[Pages 预览访问控制](https://developers.cloudflare.com/pages/configuration/preview-deployments/#customize-preview-deployments-access)、[Pages Functions limits](https://developers.cloudflare.com/pages/functions/wrangler-configuration/#limits)。

## 🔧 变量说明

| 变量名 | 示例 | 必填 | 备注 |
|--|--|--|--|
| URL302 | `https://t.me/CMLiussss` |❌| 主页302跳转 |
| URL | `nginx` |❌| 本地 nginx 主页；远程主页代理已禁用 |
| UA | `netcraft` |❌| 支持多元素, 元素之间使用空格或换行作间隔 |

# 🛠️ 第三方 DockerHub 镜像服务

**注意:**

- 以下内容仅做镜像服务的整理与搜集，未做任何安全性检测和验证。
- 使用前请自行斟酌，并根据实际需求进行必要的安全审查。
- 本列表中的任何服务都不做任何形式的安全承诺或保证。

| DockerHub 镜像仓库 | 镜像加地址 |
| ------------------ | ----------- |
| [bestcfipas 镜像服务](https://t.me/bestcfipas/4018) | `https://docker.registry.cyou` |
|  | `https://docker-cf.registry.cyou` |
|  | `https://registry.lfree.org` |
| [zero_free 镜像服务](https://t.me/zero_free/80) | `https://docker.jsdelivr.fyi` |
|  | `https://docker.aeko.cn` |
| [mingyu 镜像服务](https://github.com/ymyuuu/HubP) | `https://hubp.de` |
| [Docker 镜像加速站](https://docker.1panel.live)  | `https://docker.1panel.live` |
| [Hub Proxy](https://hub.rat.dev) | `https://hub.rat.dev` |
| [DaoCloud 镜像站](https://github.com/DaoCloud/public-image-mirror) | `https://docker.m.daocloud.io` |

# 🙏 鸣谢
### 💖 赞助支持 - 提供云服务器
- [![digitalvirt.com](https://digitalvirt.com/templates/BlueWhite/img/logo-dark.svg)](https://url.cmliussss.com/dv)

### 🛠 开源代码引用
- [muzihuaner](https://github.com/muzihuaner)
- [V2ex网友](https://global.v2ex.com/t/1007922)
- [ciiiii](https://github.com/ciiiii/cloudflare-docker-proxy)
- [ChatGPT](https://chatgpt.com/)
- [白嫖哥](https://t.me/bestcfipas/1900)
- [zero_free频道](https://t.me/zero_free/80)
- [dongyubin](https://github.com/cmliu/CF-Workers-docker.io/issues/8)
- [kiko923](https://github.com/cmliu/CF-Workers-docker.io/issues/5)
