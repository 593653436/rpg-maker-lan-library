# 雾灯游戏柜：浏览器/libretro 对本游戏窗口尺寸 API 的只读兼容。
# 文件名以 z- 开头，确保在内置 win32_wrap.rb 之后执行。
# 只覆盖安全的画布尺寸语义；不操作桌面窗口，不访问 NAS。

module Win32API_Impl
  module User32
    class FindWindow < FindWindowA
    end

    class GetDesktopWindow
      def call(args)
        42
      end
    end

    class GetWindowRect < GetClientRect
    end

    class GetWindowLong
      def call(args)
        0
      end
    end

    class GetSystemMetrics
      def call(args)
        0
      end
    end

    class SystemParametersInfo
      def call(args)
        return 0 unless args[0] == 0x30
        rect = [0, 0, Graphics.width, Graphics.height]
        memcpy_string(args[2], rect.pack('l4'))
        1
      end
    end

    class SetWindowPos
      def call(args)
        1
      end
    end
  end
end
