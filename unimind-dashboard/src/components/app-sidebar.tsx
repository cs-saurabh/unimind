"use client"

import * as React from "react"
import {
    Zap,
    Database,
    Brain,
    ScrollText,
    Share2,
    Activity,
} from "lucide-react"

import { NavProjects } from "@/components/nav-projects"
import { TeamSwitcher } from "@/components/team-switcher"
import {
    Sidebar,
    SidebarContent,
    SidebarHeader,
    SidebarRail,
} from "@/components/ui/sidebar"

const data = {
    // user: {
    //     name: "shadcn",
    //     email: "m@example.com",
    //     avatar: "/avatars/shadcn.jpg",
    // },
    teams: [
        {
            name: "UniMind",
            logo: Brain,
            plan: "",
        },
    ],
    navMain: [],
    projects: [
        {
            name: "Queries",
            url: "/dashboard/queries",
            icon: Zap,
        },
        {
            name: "Schema",
            url: "/dashboard/schema",
            icon: Database,
        },
        {
            name: "Graph",
            url: "/dashboard/graph",
            icon: Share2,
        },
        {
            name: "Audit Logs",
            url: "/dashboard/audit-logs",
            icon: ScrollText,
        },
        {
            name: "Observability",
            url: "/dashboard/observability",
            icon: Activity,
        },
        // {
        //     name: "Analytics",
        //     url: "/dashboard/analytics",
        //     icon: BarChart3,
        // },
    ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
    return (
        <Sidebar collapsible="icon" {...props}>
            <SidebarHeader>
                <TeamSwitcher teams={data.teams} />
            </SidebarHeader>
            <SidebarContent>
                <NavProjects projects={data.projects} />
            </SidebarContent>
            {/* <SidebarFooter>
                <NavUser user={data.user} />
            </SidebarFooter> */}
            <SidebarRail />
        </Sidebar>
    )
}
