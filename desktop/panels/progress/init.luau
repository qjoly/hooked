--!strict
local ui = require("@rune/ui")
local hooked = require("@hooked")

type Step = { title: string, status: string, detail: string? }
type State = { goal: string?, steps: { Step }? }

local state: State = hooked.state or {}
local ticked: { [number]: boolean } = {}

hooked.changed:Connect(function(s: State)
	state = s
end)

local COLORS = { done = "success", running = "info", failed = "danger", todo = "text-faint" }
local MARKS = { done = "✓", running = "●", failed = "✗", todo = "○" }

local function counts(steps: { Step })
	local done = 0
	for _, s in steps do
		if s.status == "done" then
			done += 1
		end
	end
	return done, #steps
end

local function bar(done: number, total: number)
	local frac = if total > 0 then done / total else 0
	return ui.row({ w = "full", h = 6, radius = 3, fill = "border-weak", clip = true }, {
		ui.box({ w = math.max(1, math.floor(432 * frac)), h = 6, radius = 3, fill = "success" }, {}),
	})
end

local function step(i: number, s: Step)
	local status = s.status or "todo"
	return ui.row({
		key = `step-{i}`,
		w = "full",
		px = 8,
		py = 6,
		gap = 10,
		radius = 6,
		align = "center",
		fill = if ticked[i] then "hover" else nil,
		hover = "hover",
		onPress = function()
			ticked[i] = not ticked[i]
		end,
	}, {
		ui.text(MARKS[status] or "○", { size = 13, weight = "bold", color = COLORS[status] or "text-faint" }),
		ui.col({ grow = 1, gap = 2 }, {
			ui.text(s.title, { size = 13, color = "text" }),
			if s.detail then ui.text(s.detail, { size = 11, color = "text-muted" }) else nil,
		}),
		ui.text(if ticked[i] then "flagged" else "", { size = 11, color = "warning" }),
	})
end

local function flagged(): { string }
	local out = {}
	for i, s in state.steps or {} do
		if ticked[i] then
			table.insert(out, s.title)
		end
	end
	return out
end

return {
	render = function(view)
		local steps = state.steps or {}
		local done, total = counts(steps)
		local rows = {}
		for i, s in steps do
			table.insert(rows, step(i, s))
		end
		return ui.col({ w = "full", pad = 16, gap = 12 }, {
			ui.col({ w = "full", gap = 6 }, {
				ui.row({ w = "full", align = "center" }, {
					ui.text(state.goal or "Progress", { size = 15, weight = "semibold", color = "text" }),
					ui.spacer(),
					ui.text(`{done}/{total}`, { size = 12, color = "text-muted", tabular = true }),
				}),
				bar(done, total),
			}),
			ui.col({ w = "full", gap = 2 }, rows),
			ui.text("Click a step to flag it.", { size = 11, color = "text-faint" }),
		})
	end,
	actions = function()
		local picked = flagged()
		return {
			{ label = "Looks good", send = { action = "approve" } },
			if #picked > 0 then { label = `Flag {#picked} step(s)`, send = { action = "flag", steps = picked } } else nil,
		}
	end,
}
