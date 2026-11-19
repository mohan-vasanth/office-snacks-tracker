package com.office.snacks.entity;

import jakarta.persistence.*;
import java.time.Instant;

@Entity @Table(name="snacks", uniqueConstraints=@UniqueConstraint(columnNames="name"))
public class Snack {
    @Id @GeneratedValue(strategy=GenerationType.IDENTITY) private Long id;
    @Column(nullable=false, length=120) private String name;
    @Column(nullable=false) private boolean active=true;
    @Column(name="created_at", nullable=false, updatable=false) private Instant createdAt=Instant.now();
    protected Snack() {}
    public Snack(String name, boolean active){this.name=name;this.active=active;}
    public Long getId(){return id;} public String getName(){return name;} public boolean isActive(){return active;} public Instant getCreatedAt(){return createdAt;}
    public void update(String name, boolean active){this.name=name;this.active=active;}
}
