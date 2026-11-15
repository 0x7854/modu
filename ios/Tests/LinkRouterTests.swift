import Darwin
import Foundation

// Executable regression tests. They do not import XCTest and do not need
// Xcode or an iOS SDK; compile them together with Modu/LinkRouter.swift using
// Scripts/test-link-router.sh.

private struct TestFailure: Error {}

@main
struct LinkRouterTests {
    private static var checks = 0
    private static var failures = 0

    static func main() {
        testValidOrigins()
        testInvalidOrigins()
        testValidLinks()
        testInvalidLinks()
        testForeignServerMatching()

        print("LinkRouterTests: \(checks - failures)/\(checks) checks passed")
        if failures > 0 {
            exit(1)
        }
    }

    // MARK: - Origins

    private static func testValidOrigins() {
        expectOrigin("https://example.com", "https://example.com", "plain https origin")
        expectOrigin("HTTPS://Example.COM/", "https://example.com", "scheme and host case normalized")
        expectOrigin("https://Example.COM:443/", "https://example.com", "default port removed")
        expectOrigin("https://example.com:8443", "https://example.com:8443", "explicit port kept")
        expectOrigin("https://192.0.2.10", "https://192.0.2.10", "IPv4 origin")
        expectOrigin("https://[2001:db8::1]", "https://[2001:db8::1]", "IPv6 origin")
        expectOrigin(
            "https://[2001:db8::1]:8443",
            "https://[2001:db8::1]:8443",
            "IPv6 origin with port"
        )
        expectOrigin("https://xn--fiqs8s.example", "https://xn--fiqs8s.example", "punycode host")
        expectOrigin("https://localhost:8443", "https://localhost:8443", "localhost for local testing")

        let padded = " \n https://Example.com:443/ \t"
        do {
            let origin = try ServerOrigin.parseUserInput(padded)
            expect(origin.absoluteString == "https://example.com", "user input trims outer whitespace")
        } catch {
            fail("user input trims outer whitespace: threw \(error)")
        }

        do {
            _ = try ServerOrigin(validating: " https://example.com")
            fail("strict origin parse rejects leading whitespace")
        } catch {
            pass()
        }
    }

    private static func testInvalidOrigins() {
        let invalid = [
            "",
            "   ",
            "http://example.com",
            "ftp://example.com",
            "example.com",
            "//example.com",
            "https://",
            "https:///path",
            "https://example.com/path",
            "https://example.com?x=1",
            "https://example.com#fragment",
            "https://user@example.com",
            "https://user:pass@example.com",
            "https://example.com@evil.com",
            "https://example.com%2f@evil.com",
            "https://evil.com\\@example.com",
            "https://exa mple.com",
            "https://example.com\n",
            "https://example.com:abc",
            "https://example.com:0",
            "https://example.com:65536",
            "https://example..com",
            "https://example.com.",
            "https://-bad.example.com",
            "https://bad-.example.com",
            "https://bad_.example.com",
            "https://例子.测试",
            "https://[2001:db8:::1]",
            "https://[2001:db8::1",
            "https://[]",
            "https://[1:2:3:4:5:6:7:8:9]",
        ]
        for raw in invalid {
            do {
                _ = try ServerOrigin(validating: raw)
                fail("invalid origin accepted: \(raw.debugDescription)")
            } catch {
                pass()
            }
        }

        do {
            _ = try ServerOrigin.parseUserInput(" \n\t ")
            fail("blank user input rejected")
        } catch {
            pass()
        }
    }

    // MARK: - Links

    private static func testValidLinks() {
        let document = "0123456789abcdef0123456789abcdef"
        let canonicalServer = "https://example.com"
        let validLinks = [
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=\(document)",
            "MODU-READER://OPEN?server=https%3A%2F%2Fexample.com&document=\(document)",
            "modu-reader://open/?server=https%3A%2F%2FExample.com%3A443&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com%3A8443&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2F%5B2001%3Adb8%3A%3A1%5D&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fxn--fiqs8s.example&document=\(document)",
        ]
        for raw in validLinks {
            do {
                let link = try DeepLink.parse(raw)
                expect(DeepLink.isDocumentID(link.documentID), "link document ID valid: \(raw)")
                expect(link.documentID == document, "link keeps document ID: \(raw)")
                guard raw.contains("8443") || raw.contains("2001") || raw.contains("xn--") else {
                    expect(link.server.absoluteString == canonicalServer, "link server canonical: \(raw)")
                    continue
                }
                pass()
            } catch {
                fail("valid link rejected: \(raw) -> \(error)")
            }
        }

        do {
            let link = try DeepLink.parse(
                "modu-reader://open?server=https%3A%2F%2FEXAMPLE.com%3A443&document=\(document)"
            )
            expect(link.server.absoluteString == "https://example.com", "link normalizes default port")
        } catch {
            fail("link normalizes default port: threw \(error)")
        }

        do {
            let link = try DeepLink.parse(
                "modu-reader://open?server=https%3A%2F%2Fexample.com&document=%30%31%32%33%34%35%36%37%38%39abcdef0123456789abcdef"
            )
            expect(link.documentID == document, "percent-encoded document value is decoded")
        } catch {
            fail("percent-encoded document value is decoded: threw \(error)")
        }
    }

    private static func testInvalidLinks() {
        let document = "0123456789abcdef0123456789abcdef"
        let invalid = [
            "",
            "modu-reader://",
            "modu-reader://open",
            "modu-reader://open?",
            "modu-reader://evil?server=https%3A%2F%2Fexample.com&document=\(document)",
            "modu-reader://user@open?server=https%3A%2F%2Fexample.com&document=\(document)",
            "modu-reader://open:443?server=https%3A%2F%2Fexample.com&document=\(document)",
            "modu-reader://open/path?server=https%3A%2F%2Fexample.com&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=\(document)#fragment",
            "https://open?server=https%3A%2F%2Fexample.com&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com",
            "modu-reader://open?document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=\(document)&extra=1",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&server=https%3A%2F%2Fexample.com",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=\(document)&document=\(document)",
            "modu-reader://open?server=&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=0123456789ABCDEF0123456789ABCDEF",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=0123456789abcdef0123456789abcde",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=0123456789abcdef0123456789abcdef0",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=0123456789abcdef0123456789abcdeg",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=%2F123456789abcdef0123456789abcdef",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=\(document)%0A",
            "modu-reader://open?server=http%3A%2F%2Fexample.com&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com%2Fpath&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com%3Fq%3D1&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fuser%40example.com&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com%0A&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com%2F%2Fevil.example&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fevil.example%5C%40example.com&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com%23%40evil.example&document=\(document)",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=\(document)&bad=%zz",
            "modu-reader://open?server=https%3A%2F%2Fexample.com&document=\(document) ",
        ]
        for raw in invalid {
            do {
                _ = try DeepLink.parse(raw)
                fail("invalid link accepted: \(raw.debugDescription)")
            } catch {
                pass()
            }
        }
    }

    private static func testForeignServerMatching() {
        let document = "0123456789abcdef0123456789abcdef"
        do {
            let configured = try ServerOrigin(validating: "https://example.com")
            let same = try DeepLink.parse(
                "modu-reader://open?server=https%3A%2F%2FEXAMPLE.com%3A443&document=\(document)"
            )
            let foreign = try DeepLink.parse(
                "modu-reader://open?server=https%3A%2F%2Fevil.example&document=\(document)"
            )
            expect(same.matches(server: configured), "equivalent server matches configured server")
            expect(!foreign.matches(server: configured), "foreign server does not match configured server")
            expect(foreign.server.host == "evil.example", "foreign server is parsed but not trusted")
        } catch {
            fail("server matching test threw \(error)")
        }
    }

    // MARK: - Helpers

    private static func expectOrigin(_ raw: String, _ canonical: String, _ name: String) {
        do {
            let origin = try ServerOrigin(validating: raw)
            expect(origin.absoluteString == canonical, "\(name): \(origin.absoluteString) != \(canonical)")
        } catch {
            fail("\(name): threw \(error)")
        }
    }

    private static func expect(_ condition: Bool, _ name: String) {
        checks += 1
        if condition {
            print("ok   \(name)")
        } else {
            failures += 1
            print("FAIL \(name)")
        }
    }

    private static func pass() {
        checks += 1
    }

    private static func fail(_ message: String) {
        checks += 1
        failures += 1
        print("FAIL \(message)")
    }
}
