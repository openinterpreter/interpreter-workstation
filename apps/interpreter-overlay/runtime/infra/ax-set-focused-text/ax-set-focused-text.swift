import Cocoa
import ApplicationServices

func copyAttribute(_ element: AXUIElement, _ attr: CFString) -> AnyObject? {
  var value: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(element, attr, &value)
  guard err == .success else {
    return nil
  }
  return value
}

func isAttributeSettable(_ element: AXUIElement, _ attr: CFString) -> Bool {
  var settable: DarwinBoolean = false
  let err = AXUIElementIsAttributeSettable(element, attr, &settable)
  return err == .success && settable.boolValue
}

func setStringValue(_ element: AXUIElement, _ value: String) -> AXError {
  let cfValue = value as CFString
  return AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, cfValue)
}

func focusedElement() -> AXUIElement? {
  let systemWide = AXUIElementCreateSystemWide()
  return copyAttribute(systemWide, kAXFocusedUIElementAttribute as CFString) as! AXUIElement?
}

func ancestorChain(start: AXUIElement, limit: Int) -> [AXUIElement] {
  var chain: [AXUIElement] = [start]
  var current: AXUIElement? = start
  for _ in 0..<limit {
    guard let element = current,
          let parent = copyAttribute(element, kAXParentAttribute as CFString) as! AXUIElement? else {
      break
    }
    chain.append(parent)
    current = parent
  }
  return chain
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  fputs("usage: ax-set-focused-text <value>\n", stderr)
  exit(64)
}

let value = args[1]
guard let focused = focusedElement() else {
  fputs("no-focused-element\n", stderr)
  exit(2)
}

for element in ancestorChain(start: focused, limit: 4) {
  if !isAttributeSettable(element, kAXValueAttribute as CFString) {
    continue
  }

  let result = setStringValue(element, value)
  if result == .success {
    print("ok")
    exit(0)
  }

  if result == .cannotComplete {
    usleep(100_000)
    let retry = setStringValue(element, value)
    if retry == .success {
      print("ok")
      exit(0)
    }
  }
}

fputs("set-failed\n", stderr)
exit(3)
