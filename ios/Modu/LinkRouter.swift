import Foundation

/// A validated HTTPS origin. The value is canonical: lower-case host, no
/// trailing slash, no user info, no path/query/fragment, and the default HTTPS
/// port (443) removed. It is deliberately strict because this origin decides
/// which server may receive the persistent web login.
public struct ServerOrigin: Equatable, Hashable, CustomStringConvertible {
    public let host: String
    public let port: Int?

    public var scheme: String { "https" }

    public var absoluteString: String {
        let hostPart = host.contains(":") ? "[\(host)]" : host
        if let port {
            return "https://\(hostPart):\(port)"
        }
        return "https://\(hostPart)"
    }

    public var url: URL {
        guard let value = URL(string: absoluteString) else {
            preconditionFailure("ServerOrigin invariant violated")
        }
        return value
    }

    public var displayName: String {
        if let port {
            return "\(host):\(port)"
        }
        return host
    }

    public var description: String { absoluteString }

    /// Parses a value from an app text field. Leading/trailing whitespace is
    /// forgiving; whitespace inside the value is not.
    public static func parseUserInput(_ raw: String) throws -> ServerOrigin {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw ServerOriginError.empty
        }
        return try ServerOrigin(validating: trimmed)
    }

    /// Strict parse. Used for values received through a custom URL scheme.
    public init(validating raw: String) throws {
        guard !raw.isEmpty else {
            throw ServerOriginError.empty
        }
        guard raw.count <= 2_048 else {
            throw ServerOriginError.tooLong
        }
        guard raw.unicodeScalars.allSatisfy({
            !CharacterSet.controlCharacters.contains($0)
                && !CharacterSet.whitespacesAndNewlines.contains($0)
        }) else {
            throw ServerOriginError.whitespaceOrControlCharacters
        }
        guard !raw.contains("\\") else {
            throw ServerOriginError.malformedURL
        }
        // A host never needs percent encoding here. Rejecting it avoids
        // ambiguity between a literal host and an encoded authority/path.
        guard !raw.contains("%") else {
            throw ServerOriginError.percentEncodingNotAllowed
        }
        guard let components = URLComponents(string: raw) else {
            throw ServerOriginError.malformedURL
        }
        guard components.scheme?.lowercased() == "https" else {
            throw ServerOriginError.unsupportedScheme
        }
        guard components.user == nil, components.password == nil else {
            throw ServerOriginError.credentialsNotAllowed
        }
        guard components.query == nil, components.fragment == nil else {
            throw ServerOriginError.queryOrFragmentNotAllowed
        }
        guard components.path.isEmpty || components.path == "/",
              components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/" else {
            throw ServerOriginError.pathNotAllowed
        }
        guard raw.unicodeScalars.allSatisfy({ $0.isASCII }) else {
            throw ServerOriginError.invalidHost
        }
        guard let rawHost = components.url?.host(), !rawHost.isEmpty else {
            throw ServerOriginError.missingHost
        }

        let normalizedHost: String
        if rawHost.hasPrefix("["), rawHost.hasSuffix("]") {
            let inner = String(rawHost.dropFirst().dropLast()).lowercased()
            guard Self.isValidIPv6Literal(inner) else {
                throw ServerOriginError.invalidHost
            }
            normalizedHost = inner
        } else if rawHost.contains(":") {
            // Older Foundation builds may expose an IPv6 literal without the
            // brackets through URLComponents.host.
            let inner = rawHost.lowercased()
            guard Self.isValidIPv6Literal(inner) else {
                throw ServerOriginError.invalidHost
            }
            normalizedHost = inner
        } else {
            let lowercased = rawHost.lowercased()
            guard Self.isValidDomainName(lowercased) else {
                throw ServerOriginError.invalidHost
            }
            normalizedHost = lowercased
        }

        let rawPort: Int?
        if let parsedPort = components.port {
            guard parsedPort >= 1, parsedPort <= 65_535 else {
                throw ServerOriginError.invalidPort
            }
            rawPort = parsedPort
        } else {
            rawPort = nil
        }

        host = normalizedHost
        port = rawPort == 443 ? nil : rawPort
    }

    public func matches(_ other: ServerOrigin) -> Bool {
        self == other
    }

    private static func isValidDomainName(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 253 else { return false }
        guard !value.hasPrefix("."), !value.hasSuffix("."), !value.contains("..") else {
            return false
        }
        guard value.unicodeScalars.allSatisfy({ $0.isASCII }) else { return false }
        for label in value.split(separator: ".", omittingEmptySubsequences: false) {
            guard !label.isEmpty, label.count <= 63 else { return false }
            guard label.first != "-", label.last != "-" else { return false }
            for scalar in label.unicodeScalars {
                let isLetter = (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
                let isDigit = (48...57).contains(scalar.value)
                guard isLetter || isDigit || scalar.value == 45 else { return false }
            }
        }
        return true
    }

    private static func isValidIPv6Literal(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 45, value.contains(":") else { return false }
        guard !value.contains(":::"), !value.hasPrefix(":") || value.hasPrefix("::"),
              !value.hasSuffix(":") || value.hasSuffix("::") else {
            return false
        }
        for scalar in value.unicodeScalars {
            let isHex = (48...57).contains(scalar.value)
                || (97...102).contains(scalar.value)
                || (65...70).contains(scalar.value)
            guard isHex || scalar.value == 58 || scalar.value == 46 else { return false }
        }
        let compressedParts = value.components(separatedBy: "::")
        guard compressedParts.count <= 2 else { return false }
        var units = 0
        for part in compressedParts where !part.isEmpty {
            for group in part.split(separator: ":", omittingEmptySubsequences: true) {
                if group.contains(".") {
                    guard Self.isValidIPv4Literal(String(group)) else { return false }
                    units += 2
                } else {
                    guard !group.isEmpty, group.count <= 4 else { return false }
                    units += 1
                }
            }
        }
        if compressedParts.count == 2 {
            return units <= 7
        }
        return units == 8
    }

    private static func isValidIPv4Literal(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        for part in parts {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ $0.isNumber }),
                  let number = Int(part), (0...255).contains(number) else {
                return false
            }
        }
        return true
    }
}

public enum ServerOriginError: Error, Equatable {
    case empty
    case tooLong
    case whitespaceOrControlCharacters
    case percentEncodingNotAllowed
    case malformedURL
    case unsupportedScheme
    case credentialsNotAllowed
    case queryOrFragmentNotAllowed
    case pathNotAllowed
    case missingHost
    case invalidHost
    case invalidPort

    public var userMessage: String {
        switch self {
        case .empty:
            return "请输入服务器地址。"
        case .tooLong:
            return "服务器地址过长。"
        case .whitespaceOrControlCharacters:
            return "服务器地址不能包含空格或控制字符。"
        case .percentEncodingNotAllowed:
            return "服务器地址不能包含百分号编码。"
        case .malformedURL:
            return "服务器地址格式不正确。"
        case .unsupportedScheme:
            return "只支持 HTTPS 服务器地址。"
        case .credentialsNotAllowed:
            return "服务器地址不能包含用户名或密码。"
        case .queryOrFragmentNotAllowed:
            return "服务器地址只能是 HTTPS origin，不能带查询参数或片段。"
        case .pathNotAllowed:
            return "服务器地址只能是 HTTPS origin，不能带路径。"
        case .missingHost:
            return "服务器地址缺少主机名。"
        case .invalidHost:
            return "主机名无效。请使用 ASCII 域名、IPv4 或 IPv6 地址。"
        case .invalidPort:
            return "端口无效，应为 1–65535。"
        }
    }
}

/// The only supported custom link:
/// modu-reader://open?server=https%3A%2F%2Fhost&document=<32 lowercase hex>
public struct DeepLink: Equatable {
    public let server: ServerOrigin
    public let documentID: String

    public static func parse(_ url: URL) throws -> DeepLink {
        try parse(url.absoluteString)
    }

    public static func parse(_ raw: String) throws -> DeepLink {
        guard !raw.isEmpty, raw.count <= 4_096 else {
            throw LinkRouterError.malformedLink
        }
        guard raw.unicodeScalars.allSatisfy({
            !CharacterSet.controlCharacters.contains($0)
                && !CharacterSet.whitespacesAndNewlines.contains($0)
        }) else {
            throw LinkRouterError.malformedLink
        }
        guard !raw.contains("\\") else {
            throw LinkRouterError.malformedLink
        }
        guard Self.percentEncodingIsWellFormed(raw) else {
            throw LinkRouterError.malformedLink
        }
        guard let components = URLComponents(string: raw) else {
            throw LinkRouterError.malformedLink
        }
        guard components.scheme?.lowercased() == "modu-reader" else {
            throw LinkRouterError.unsupportedScheme
        }
        guard components.host?.lowercased() == "open" else {
            throw LinkRouterError.invalidLinkHost
        }
        guard components.user == nil,
              components.password == nil,
              components.port == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            throw LinkRouterError.unexpectedComponent
        }
        guard let items = components.queryItems, items.count == 2 else {
            throw LinkRouterError.invalidParameters
        }

        var values: [String: String] = [:]
        for item in items {
            guard item.name == "server" || item.name == "document" else {
                throw LinkRouterError.invalidParameters
            }
            guard values[item.name] == nil, let value = item.value, !value.isEmpty else {
                throw LinkRouterError.invalidParameters
            }
            values[item.name] = value
        }
        guard let serverValue = values["server"], let documentID = values["document"] else {
            throw LinkRouterError.invalidParameters
        }
        guard Self.isDocumentID(documentID) else {
            throw LinkRouterError.invalidDocumentID
        }

        let server: ServerOrigin
        do {
            server = try ServerOrigin(validating: serverValue)
        } catch let error as ServerOriginError {
            throw LinkRouterError.invalidServer(error)
        } catch {
            throw LinkRouterError.invalidServer(.malformedURL)
        }
        return DeepLink(server: server, documentID: documentID)
    }

    public func matches(server: ServerOrigin) -> Bool {
        self.server == server
    }

    public static func isDocumentID(_ value: String) -> Bool {
        guard value.count == 32 else { return false }
        for scalar in value.unicodeScalars {
            guard (48...57).contains(scalar.value) || (97...102).contains(scalar.value) else {
                return false
            }
        }
        return true
    }

    private static func percentEncodingIsWellFormed(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        var index = 0
        while index < scalars.count {
            if scalars[index].value == 37 {
                guard index + 2 < scalars.count,
                      Self.isASCIIHex(scalars[index + 1]),
                      Self.isASCIIHex(scalars[index + 2]) else {
                    return false
                }
                index += 3
            } else {
                index += 1
            }
        }
        return true
    }

    private static func isASCIIHex(_ scalar: UnicodeScalar) -> Bool {
        (48...57).contains(scalar.value)
            || (65...70).contains(scalar.value)
            || (97...102).contains(scalar.value)
    }
}

public enum LinkRouterError: Error, Equatable {
    case malformedLink
    case unsupportedScheme
    case invalidLinkHost
    case unexpectedComponent
    case invalidParameters
    case invalidDocumentID
    case invalidServer(ServerOriginError)

    public var userMessage: String {
        switch self {
        case .malformedLink:
            return "链接格式无效。"
        case .unsupportedScheme:
            return "链接不是 modu-reader 协议。"
        case .invalidLinkHost:
            return "链接目标必须是 open。"
        case .unexpectedComponent:
            return "链接包含不允许的路径、端口、片段或登录信息。"
        case .invalidParameters:
            return "链接必须且只能包含 server 和 document 两个参数。"
        case .invalidDocumentID:
            return "文稿 ID 必须是 32 位小写十六进制。"
        case .invalidServer(let error):
            return error.userMessage
        }
    }
}
