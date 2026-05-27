class Localcode < Formula
  desc "Local-first AI coding assistant — Claude Code clone with 7 backends"
  homepage "https://github.com/grosa787/localcode"
  version "__VERSION__"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/grosa787/localcode/releases/download/v__VERSION__/localcode-darwin-arm64.tar.gz"
      sha256 "__SHA256_DARWIN_ARM64__"
    end
    on_intel do
      url "https://github.com/grosa787/localcode/releases/download/v__VERSION__/localcode-darwin-x64.tar.gz"
      sha256 "__SHA256_DARWIN_X64__"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/grosa787/localcode/releases/download/v__VERSION__/localcode-linux-arm64.tar.gz"
      sha256 "__SHA256_LINUX_ARM64__"
    end
    on_intel do
      url "https://github.com/grosa787/localcode/releases/download/v__VERSION__/localcode-linux-x64.tar.gz"
      sha256 "__SHA256_LINUX_X64__"
    end
  end

  def install
    bin.install "localcode"
  end

  test do
    assert_match "LocalCode", shell_output("#{bin}/localcode --version")
  end
end
